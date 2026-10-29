// Candidate evidence domain rules: validation and normalization of untrusted
// client input. Pure functions, no HTTP or database knowledge.
//
// Normalization only tidies whitespace and puts URLs in their canonical WHATWG
// form. It never infers, rewrites or invents candidate facts, and URLs are
// never fetched or resolved.

import { EVIDENCE_SOURCE_TYPES, type EvidenceSourceType } from "./schema.js";
import { checkText, codePointLength, isPlainObject, nullableText, type FieldError } from "./profile-validation.js";
import { parseSkillId } from "./skill-validation.js";

export interface EvidenceInput {
  type: EvidenceSourceType;
  title: string;
  description: string | null;
  url: string | null;
}

// Text limits are counted in Unicode code points, after normalization. The
// URL limit applies to the canonical form that is stored.
export const EVIDENCE_LIMITS = {
  title: 200,
  description: 5_000,
  url: 2_048,
  skillIds: 500,
} as const;

const EVIDENCE_KEYS = ["type", "title", "description", "url"] as const;

export type EvidenceValidationResult =
  | { ok: true; value: EvidenceInput }
  | { ok: false; errors: FieldError[] };

export type SkillIdsValidationResult = { ok: true; value: number[] } | { ok: false; errors: FieldError[] };

export type ReviewValidationResult = { ok: true; value: { expectedUpdatedAt: string } } | { ok: false; errors: FieldError[] };

function unknownKeys(body: Record<string, unknown>, allowed: readonly string[], errors: FieldError[]) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) errors.push({ field: key, message: "is not an allowed field" });
  }
}

function type(raw: unknown, errors: FieldError[]): EvidenceSourceType {
  if (typeof raw === "string" && (EVIDENCE_SOURCE_TYPES as readonly string[]).includes(raw)) {
    return raw as EvidenceSourceType;
  }
  errors.push({ field: "type", message: `must be one of ${EVIDENCE_SOURCE_TYPES.join(", ")}` });
  return "other";
}

// Same rules as skill names: runs of ASCII whitespace (the set the database
// title_not_blank check uses) collapse to one space and the ends are trimmed;
// titles made of nothing but Unicode whitespace are rejected.
const ASCII_WHITESPACE_RUN = /[\t\n\v\f\r ]+/g;
const ONLY_WHITESPACE = /^[\p{White_Space}﻿]*$/u;

function title(raw: unknown, errors: FieldError[]): string {
  const field = "title";
  if (typeof raw !== "string") {
    errors.push({ field, message: "must be a string" });
    return "";
  }
  if (!checkText(raw, field, errors)) return "";
  const value = raw.replace(ASCII_WHITESPACE_RUN, " ").replace(/^ | $/g, "");
  if (ONLY_WHITESPACE.test(value)) {
    errors.push({ field, message: "must not be empty" });
    return "";
  }
  if (codePointLength(value) > EVIDENCE_LIMITS.title) {
    errors.push({ field, message: `must be at most ${EVIDENCE_LIMITS.title} characters` });
    return "";
  }
  return value;
}

// Characters the WHATWG parser would silently strip, percent-encode or
// reinterpret: C0 controls, space, DEL, C1 controls, and the backslash (read as
// "/" in http(s) URLs). Rejecting them keeps the stored URL a faithful
// canonical form of what the candidate typed, not a parser repair.
const URL_FORBIDDEN = /[\u0000- \u007F-\u009F\\]/;

// The raw text must spell out the scheme and "//" itself; the parser would
// otherwise accept and repair "http:example.com" or "https:/example.com".
const EXPLICIT_HTTP_PREFIX = /^https?:\/\//i;

function url(raw: unknown, errors: FieldError[]): string | null {
  const field = "url";
  if (raw === null) return null;
  if (typeof raw !== "string") {
    errors.push({ field, message: "must be a string or null" });
    return null;
  }
  if (!checkText(raw, field, errors)) return null;
  const value = raw.trim();
  if (value === "") return null;

  const invalid = () => {
    errors.push({ field, message: "must be an absolute http or https URL with a host and no credentials" });
    return null;
  };
  if (URL_FORBIDDEN.test(value) || !EXPLICIT_HTTP_PREFIX.test(value)) return invalid();
  // The authority as typed: non-empty (no "http:///host" repair) and free of
  // "@", so no user info, not even an empty one, is dropped silently.
  const authority = value.slice(value.indexOf("//") + 2).split(/[/?#]/, 1)[0];
  if (authority === "" || authority.includes("@")) return invalid();

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalid();
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname === "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return invalid();
  }
  if (parsed.href.length > EVIDENCE_LIMITS.url) {
    errors.push({ field, message: `must be at most ${EVIDENCE_LIMITS.url} characters` });
    return null;
  }
  return parsed.href;
}

function validate(body: unknown, mode: "create" | "replace"): EvidenceValidationResult {
  if (!isPlainObject(body)) {
    return { ok: false, errors: [{ field: "body", message: "must be a JSON object" }] };
  }

  const errors: FieldError[] = [];
  unknownKeys(body, EVIDENCE_KEYS, errors);
  // Create: type and title are required. Replace: every key is required, so
  // an omitted field never silently clears stored data.
  for (const key of mode === "create" ? (["type", "title"] as const) : EVIDENCE_KEYS) {
    if (!Object.hasOwn(body, key)) {
      const message = key === "type" || key === "title" ? "is required" : "is required (use null for no value)";
      errors.push({ field: key, message });
    }
  }

  // Missing keys are validated as null (the create default); on replace this
  // only avoids duplicate errors, since a missing key is already an error.
  const input: Record<string, unknown> = { description: null, url: null, ...body };

  const value: EvidenceInput = {
    type: Object.hasOwn(body, "type") ? type(input.type, errors) : "other",
    title: Object.hasOwn(body, "title") ? title(input.title, errors) : "",
    description: nullableText(input.description, "description", EVIDENCE_LIMITS.description, true, errors),
    url: url(input.url, errors),
  };

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

// POST body: type and title are required; description and url may be omitted
// (null). origin, reviewedAt, skillIds and any other key are rejected.
export function validateEvidenceCreate(body: unknown): EvidenceValidationResult {
  return validate(body, "create");
}

// PUT body: full replacement of the four editable fields, all required (use
// null to clear description or url). Any other key is rejected.
export function validateEvidenceReplace(body: unknown): EvidenceValidationResult {
  return validate(body, "replace");
}

const MAX_INT4 = 2_147_483_647;

// PUT /evidence/:id/skills body: { skillIds: [...] }, the complete set of
// linked skills. Ids must be JSON integers (not strings) in PostgreSQL integer
// range; duplicates are rejected rather than dropped. [] unlinks every skill.
export function validateSkillIds(body: unknown): SkillIdsValidationResult {
  if (!isPlainObject(body)) {
    return { ok: false, errors: [{ field: "body", message: "must be a JSON object" }] };
  }
  const errors: FieldError[] = [];
  unknownKeys(body, ["skillIds"], errors);
  const raw = body.skillIds;
  const ids: number[] = [];
  if (!Object.hasOwn(body, "skillIds")) {
    errors.push({ field: "skillIds", message: "is required (use [] to unlink every skill)" });
  } else if (!Array.isArray(raw)) {
    errors.push({ field: "skillIds", message: "must be an array of skill ids" });
  } else if (raw.length > EVIDENCE_LIMITS.skillIds) {
    errors.push({ field: "skillIds", message: `must contain at most ${EVIDENCE_LIMITS.skillIds} skill ids` });
  } else {
    raw.forEach((item, i) => {
      const field = `skillIds[${i}]`;
      if (typeof item !== "number" || !Number.isInteger(item) || item < 1 || item > MAX_INT4) {
        errors.push({ field, message: `must be an integer from 1 to ${MAX_INT4}` });
        return;
      }
      if (ids.includes(item)) {
        errors.push({ field, message: "must not repeat an earlier value" });
        return;
      }
      ids.push(item);
    });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: ids };
}

// The exact form the API serializes updatedAt in (Date#toISOString: UTC,
// milliseconds, "Z"). Anything else, such as another offset or precision, is
// rejected rather than reinterpreted.
const API_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// POST /evidence/:id/review body: { expectedUpdatedAt }, the updatedAt of the
// version the candidate reviewed.
export function validateReview(body: unknown): ReviewValidationResult {
  if (!isPlainObject(body)) {
    return { ok: false, errors: [{ field: "body", message: "must be a JSON object" }] };
  }
  const errors: FieldError[] = [];
  unknownKeys(body, ["expectedUpdatedAt"], errors);
  const raw = body.expectedUpdatedAt;
  if (!Object.hasOwn(body, "expectedUpdatedAt")) {
    errors.push({ field: "expectedUpdatedAt", message: "is required" });
  } else if (
    typeof raw !== "string" ||
    !API_TIMESTAMP.test(raw) ||
    Number.isNaN(Date.parse(raw)) ||
    new Date(raw).toISOString() !== raw
  ) {
    errors.push({ field: "expectedUpdatedAt", message: "must be an updatedAt value returned by the API" });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { expectedUpdatedAt: raw as string } };
}

// Route ids follow the skills API rule: canonical positive decimal integers
// within PostgreSQL integer range.
export const parseEvidenceId = parseSkillId;
