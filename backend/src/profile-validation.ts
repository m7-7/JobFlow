// Candidate profile domain rules: validation and normalization of untrusted
// client input. Pure functions, no HTTP or database knowledge.
//
// Normalization only tidies whitespace. It never infers, rewrites or invents
// candidate facts.

export const WORK_MODELS = ["remote", "hybrid", "onsite", "flexible"] as const;
export type WorkModel = (typeof WORK_MODELS)[number];

export interface ProfileInput {
  headline: string | null;
  experienceSummary: string | null;
  location: string | null;
  targetRoles: string[];
  workModel: WorkModel | null;
  careerInstructions: string | null;
}

// Limits are counted in Unicode code points, after normalization.
export const LIMITS = {
  headline: 200,
  location: 200,
  experienceSummary: 10_000,
  careerInstructions: 5_000,
  targetRolesCount: 20,
  targetRoleLength: 100,
} as const;

const PROFILE_KEYS = [
  "headline",
  "experienceSummary",
  "location",
  "targetRoles",
  "workModel",
  "careerInstructions",
] as const;

const EMPTY_PROFILE: ProfileInput = {
  headline: null,
  experienceSummary: null,
  location: null,
  targetRoles: [],
  workModel: null,
  careerInstructions: null,
};

export interface FieldError {
  field: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; value: ProfileInput }
  | { ok: false; errors: FieldError[] };

// C0 control characters other than tab, line feed and carriage return, plus DEL.
// PostgreSQL text and jsonb cannot store NUL at all, so these must be rejected
// here rather than surfacing as a database error.
const FORBIDDEN_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

// With the u flag, only unpaired (invalid) surrogates match this range.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

// Single-line values: trim and collapse internal whitespace runs to one space.
function normalizeSingleLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Multi-line values: trim the ends only, so paragraphs and line breaks the
// candidate wrote are kept as-is. CRLF is unified to LF.
function normalizeMultiLine(s: string): string {
  return s.replace(/\r\n?/g, "\n").trim();
}

function checkText(raw: string, field: string, errors: FieldError[]): boolean {
  if (LONE_SURROGATE.test(raw)) {
    errors.push({ field, message: "must be valid Unicode text" });
    return false;
  }
  if (FORBIDDEN_CONTROL_CHARS.test(raw)) {
    errors.push({ field, message: "must not contain control characters" });
    return false;
  }
  return true;
}

// Nullable text: string or null. A string that is empty after trimming is
// stored as null, so "not provided" has exactly one representation.
function nullableText(
  raw: unknown,
  field: string,
  maxLength: number,
  multiLine: boolean,
  errors: FieldError[]
): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string") {
    errors.push({ field, message: "must be a string or null" });
    return null;
  }
  if (!checkText(raw, field, errors)) return null;
  const value = multiLine ? normalizeMultiLine(raw) : normalizeSingleLine(raw);
  if (codePointLength(value) > maxLength) {
    errors.push({ field, message: `must be at most ${maxLength} characters` });
    return null;
  }
  return value === "" ? null : value;
}

// Target roles: array of non-empty strings. Duplicates (compared
// case-insensitively, after whitespace normalization) are removed, keeping the
// first occurrence and the original order.
function targetRoles(raw: unknown, errors: FieldError[]): string[] {
  const field = "targetRoles";
  if (!Array.isArray(raw)) {
    errors.push({ field, message: "must be an array of strings" });
    return [];
  }
  if (raw.length > LIMITS.targetRolesCount) {
    errors.push({ field, message: `must contain at most ${LIMITS.targetRolesCount} roles` });
    return [];
  }

  const roles: string[] = [];
  const seen = new Set<string>();
  raw.forEach((item, i) => {
    const itemField = `${field}[${i}]`;
    if (typeof item !== "string") {
      errors.push({ field: itemField, message: "must be a string" });
      return;
    }
    if (!checkText(item, itemField, errors)) return;
    const role = normalizeSingleLine(item);
    if (role === "") {
      errors.push({ field: itemField, message: "must not be empty" });
      return;
    }
    if (codePointLength(role) > LIMITS.targetRoleLength) {
      errors.push({ field: itemField, message: `must be at most ${LIMITS.targetRoleLength} characters` });
      return;
    }
    const key = role.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      roles.push(role);
    }
  });
  return roles;
}

function workModel(raw: unknown, errors: FieldError[]): WorkModel | null {
  if (raw === null) return null;
  if (typeof raw === "string" && (WORK_MODELS as readonly string[]).includes(raw)) {
    return raw as WorkModel;
  }
  errors.push({ field: "workModel", message: `must be one of ${WORK_MODELS.join(", ")}, or null` });
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Validates a complete PUT body. All six keys are required (values may be
// null / empty array); any other key, including id or updatedAt, is rejected.
export function validateProfileInput(body: unknown): ValidationResult {
  if (!isPlainObject(body)) {
    return { ok: false, errors: [{ field: "body", message: "must be a JSON object" }] };
  }

  const errors: FieldError[] = [];
  for (const key of Object.keys(body)) {
    if (!(PROFILE_KEYS as readonly string[]).includes(key)) {
      errors.push({ field: key, message: "is not an allowed field" });
    }
  }
  for (const key of PROFILE_KEYS) {
    if (!Object.hasOwn(body, key)) {
      errors.push({ field: key, message: "is required (use null or [] for no value)" });
    }
  }

  // The fields that are present are still validated, so one response lists
  // every problem. Missing keys get a neutral placeholder only to avoid
  // duplicate errors; any error above already makes the result invalid.
  const input: Record<string, unknown> = { ...EMPTY_PROFILE, ...body };

  const value: ProfileInput = {
    headline: nullableText(input.headline, "headline", LIMITS.headline, false, errors),
    experienceSummary: nullableText(
      input.experienceSummary,
      "experienceSummary",
      LIMITS.experienceSummary,
      true,
      errors
    ),
    location: nullableText(input.location, "location", LIMITS.location, false, errors),
    targetRoles: targetRoles(input.targetRoles, errors),
    workModel: workModel(input.workModel, errors),
    careerInstructions: nullableText(
      input.careerInstructions,
      "careerInstructions",
      LIMITS.careerInstructions,
      true,
      errors
    ),
  };

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}
