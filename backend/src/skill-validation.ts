// Candidate skill domain rules: validation and normalization of untrusted
// client input. Pure functions, no HTTP or database knowledge.
//
// Normalization only tidies ASCII whitespace in the name and the ends of the
// notes. It never infers, rewrites or invents candidate facts.

import { EXPERIENCE_CONTEXTS, type ExperienceContext } from "./schema.js";
import { checkText, codePointLength, isPlainObject, nullableText, type FieldError } from "./profile-validation.js";

export interface SkillInput {
  name: string;
  experienceContexts: ExperienceContext[];
  practicalConfidence: number | null;
  interviewConfidence: number | null;
  experienceMonths: number | null;
  lastUsedYear: number | null;
  notes: string | null;
}

// Text limits are counted in Unicode code points, after normalization.
export const SKILL_LIMITS = {
  name: 100,
  notes: 2_000,
  confidenceMin: 1,
  confidenceMax: 5,
  experienceMonthsMin: 0,
  experienceMonthsMax: 1200,
  lastUsedYearMin: 1950,
  lastUsedYearMax: 2100,
} as const;

const SKILL_KEYS = [
  "name",
  "experienceContexts",
  "practicalConfidence",
  "interviewConfidence",
  "experienceMonths",
  "lastUsedYear",
  "notes",
] as const;

// Values for fields a create request may omit. name has no default.
const CREATE_DEFAULTS: Omit<SkillInput, "name"> = {
  experienceContexts: [],
  practicalConfidence: null,
  interviewConfidence: null,
  experienceMonths: null,
  lastUsedYear: null,
  notes: null,
};

const REQUIRED_MESSAGES: Record<(typeof SKILL_KEYS)[number], string> = {
  name: "is required",
  experienceContexts: "is required (use [] for no value)",
  practicalConfidence: "is required (use null for no value)",
  interviewConfidence: "is required (use null for no value)",
  experienceMonths: "is required (use null for no value)",
  lastUsedYear: "is required (use null for no value)",
  notes: "is required (use null for no value)",
};

export type SkillValidationResult =
  | { ok: true; value: SkillInput }
  | { ok: false; errors: FieldError[] };

// The same ASCII whitespace set (tab, LF, VT, FF, CR, space) as the
// candidate_skill_name_normalized_unique index, so the stored name is already
// in the form the index compares. Other whitespace, such as a no-break space,
// is an ordinary character and is kept as entered.
const ASCII_WHITESPACE_RUN = /[\t\n\v\f\r ]+/g;

// Any Unicode White_Space character (which includes U+0085, unlike JS \s),
// plus U+FEFF. Used only to reject names made of nothing else.
const ONLY_WHITESPACE = /^[\p{White_Space}﻿]*$/u;

function name(raw: unknown, errors: FieldError[]): string {
  const field = "name";
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
  if (codePointLength(value) > SKILL_LIMITS.name) {
    errors.push({ field, message: `must be at most ${SKILL_LIMITS.name} characters` });
    return "";
  }
  return value;
}

// A set of allowed values. Duplicates are rejected rather than dropped.
function experienceContexts(raw: unknown, errors: FieldError[]): ExperienceContext[] {
  const field = "experienceContexts";
  if (!Array.isArray(raw)) {
    errors.push({ field, message: `must be an array of ${EXPERIENCE_CONTEXTS.join(", ")}` });
    return [];
  }
  const contexts: ExperienceContext[] = [];
  raw.forEach((item, i) => {
    const itemField = `${field}[${i}]`;
    if (typeof item !== "string" || !(EXPERIENCE_CONTEXTS as readonly string[]).includes(item)) {
      errors.push({ field: itemField, message: `must be one of ${EXPERIENCE_CONTEXTS.join(", ")}` });
      return;
    }
    if (contexts.includes(item as ExperienceContext)) {
      errors.push({ field: itemField, message: "must not repeat an earlier value" });
      return;
    }
    contexts.push(item as ExperienceContext);
  });
  return contexts;
}

function nullableInteger(raw: unknown, field: string, min: number, max: number, errors: FieldError[]): number | null {
  if (raw === null) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    errors.push({ field, message: `must be an integer from ${min} to ${max}, or null` });
    return null;
  }
  return raw;
}

function validate(
  body: unknown,
  mode: "create" | "replace",
  now: Date
): SkillValidationResult {
  if (!isPlainObject(body)) {
    return { ok: false, errors: [{ field: "body", message: "must be a JSON object" }] };
  }

  const errors: FieldError[] = [];
  for (const key of Object.keys(body)) {
    if (!(SKILL_KEYS as readonly string[]).includes(key)) {
      errors.push({ field: key, message: "is not an allowed field" });
    }
  }
  // Create: only name is required. Replace: every key is required, so an
  // omitted field never silently clears stored data.
  for (const key of mode === "create" ? (["name"] as const) : SKILL_KEYS) {
    if (!Object.hasOwn(body, key)) {
      errors.push({ field: key, message: REQUIRED_MESSAGES[key] });
    }
  }

  // Missing keys get a neutral placeholder: on create these are the
  // defaults; on replace they only avoid duplicate errors, since any error
  // above already makes the result invalid.
  const input: Record<string, unknown> = { ...CREATE_DEFAULTS, ...body };

  // A year in the future cannot be a "last used" year.
  const maxYear = Math.min(SKILL_LIMITS.lastUsedYearMax, now.getUTCFullYear());

  const value: SkillInput = {
    name: Object.hasOwn(body, "name") ? name(input.name, errors) : "",
    experienceContexts: experienceContexts(input.experienceContexts, errors),
    practicalConfidence: nullableInteger(
      input.practicalConfidence,
      "practicalConfidence",
      SKILL_LIMITS.confidenceMin,
      SKILL_LIMITS.confidenceMax,
      errors
    ),
    interviewConfidence: nullableInteger(
      input.interviewConfidence,
      "interviewConfidence",
      SKILL_LIMITS.confidenceMin,
      SKILL_LIMITS.confidenceMax,
      errors
    ),
    experienceMonths: nullableInteger(
      input.experienceMonths,
      "experienceMonths",
      SKILL_LIMITS.experienceMonthsMin,
      SKILL_LIMITS.experienceMonthsMax,
      errors
    ),
    lastUsedYear: nullableInteger(input.lastUsedYear, "lastUsedYear", SKILL_LIMITS.lastUsedYearMin, maxYear, errors),
    notes: nullableText(input.notes, "notes", SKILL_LIMITS.notes, true, errors),
  };

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

// POST body: name is required; omitted fields take their defaults ([] or
// null). Explicit null is not a default for experienceContexts and is rejected.
export function validateSkillCreate(body: unknown, now: Date = new Date()): SkillValidationResult {
  return validate(body, "create", now);
}

// PUT body: full replacement. All seven keys are required (use null or [] to
// clear a value); any other key, including id or timestamps, is rejected.
export function validateSkillReplace(body: unknown, now: Date = new Date()): SkillValidationResult {
  return validate(body, "replace", now);
}

// Route ids: canonical positive decimal integers within PostgreSQL integer
// range only. "01", "+1", "1.0", "1e3", " 1" and "2147483648" are all invalid.
const MAX_INT4 = 2_147_483_647;

export function parseSkillId(raw: string): number | null {
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) return null;
  const id = Number(raw);
  return id <= MAX_INT4 ? id : null;
}
