import type { ErrorRequestHandler } from "express";

// Final error handler. Responses carry a fixed, generic body only: no SQL,
// driver messages, hostnames, connection strings or stack traces.

// postgres.js connection-level error codes.
const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
]);

// PostgreSQL SQLSTATEs meaning "server not usable right now".
function isUnavailableSqlState(code: string): boolean {
  return (
    code.startsWith("08") || // connection exception
    code === "57P01" || // admin_shutdown
    code === "57P02" || // crash_shutdown
    code === "57P03" || // cannot_connect_now
    code === "53300" // too_many_connections
  );
}

// Drizzle wraps driver errors in a DrizzleQueryError whose own message
// contains the SQL text *and bound parameters*, i.e. profile content. Only the
// underlying driver error (`cause`) is inspected, and only for its code.
function rootCause(err: unknown): unknown {
  return err instanceof Error && err.cause instanceof Error ? err.cause : err;
}

// A PostgreSQL SQLSTATE is exactly five digits / uppercase letters.
const SQLSTATE = /^[0-9A-Z]{5}$/;

// Only codes from a known, fixed shape are logged; anything else (missing,
// malformed, or attacker-influenced) is reported as "unknown".
function safeErrorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return "unknown";
  return CONNECTION_ERROR_CODES.has(code) || SQLSTATE.test(code) ? code : "unknown";
}

// Error class name (e.g. TypeError) as a diagnostic for non-database errors.
function safeErrorName(err: unknown): string {
  return err instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(err.name) ? err.name : "unknown";
}

// Safe log diagnostic for a server-side error: a fixed category and a
// validated code (or error class name). Raw messages are never used: the
// Drizzle wrapper's message holds the SQL and its parameters, driver messages
// can quote rejected values, hostnames or the username, and stacks/serialized
// errors carry the same data. Shared by the error handler and /health.
export function safeDiagnostic(err: unknown) {
  const cause = rootCause(err);
  const code = safeErrorCode(cause);
  const unavailable = CONNECTION_ERROR_CODES.has(code) || (SQLSTATE.test(code) && isUnavailableSqlState(code));
  const category = unavailable ? "database_unavailable" : code !== "unknown" ? "database_error" : "unexpected_error";
  const detail = code !== "unknown" ? code : safeErrorName(cause);
  return { category, detail, unavailable };
}

// True only for a unique violation (SQLSTATE 23505) of the named constraint
// or unique index. Like safeDiagnostic, it reads the driver error's code and
// constraint name only, never its message or detail (which quote the values).
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  const cause = rootCause(err) as { code?: unknown; constraint_name?: unknown } | null;
  return cause?.code === "23505" && cause.constraint_name === constraint;
}

// True only for a foreign key violation (SQLSTATE 23503) of the named
// constraint. Reads the code and constraint name only, like isUniqueViolation.
export function isForeignKeyViolation(err: unknown, constraint: string): boolean {
  const cause = rootCause(err) as { code?: unknown; constraint_name?: unknown } | null;
  return cause?.code === "23503" && cause.constraint_name === constraint;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // body-parser errors (malformed JSON, oversized body, bad encoding).
  const type = (err as { type?: unknown })?.type;
  if (type === "entity.parse.failed") {
    res.status(400).json({ error: "invalid_json", message: "Request body must be a valid JSON object." });
    return;
  }
  if (type === "entity.too.large") {
    res.status(413).json({ error: "payload_too_large", message: "Request body is too large." });
    return;
  }
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    res.status(status).json({ error: "bad_request", message: "The request could not be processed." });
    return;
  }

  const { category, detail, unavailable } = safeDiagnostic(err);
  console.error(`${req.method} ${req.path} failed: ${category} [${detail}]`);

  if (unavailable) {
    res.status(503).json({
      error: "database_unavailable",
      message: "The database is currently unavailable. Please try again later.",
    });
    return;
  }
  res.status(500).json({ error: "internal_error", message: "An unexpected error occurred." });
};
