// Candidate skills: types and pure conversions between the API shape and the
// form's editable values, response checks and display helpers. No React, no
// fetch — unit-testable with node.
//
// The backend is authoritative for validation, normalization and duplicate
// names; the helpers here only convert shapes and provide display guidance.

import type { FieldErrorDetail } from "./profile.ts";

export const EXPERIENCE_CONTEXTS = ["professional", "personal_project", "academic", "learning"] as const;
export type ExperienceContext = (typeof EXPERIENCE_CONTEXTS)[number];

export const CONTEXT_LABELS: Record<ExperienceContext, string> = {
  professional: "Professional work",
  personal_project: "Personal projects",
  academic: "Academic",
  learning: "Self-study / learning",
};

// POST/PUT /api/skills request body: always all seven writable keys.
export interface SkillInput {
  name: string;
  experienceContexts: ExperienceContext[];
  practicalConfidence: number | null;
  interviewConfidence: number | null;
  experienceMonths: number | null;
  lastUsedYear: number | null;
  notes: string | null;
}

// GET/POST/PUT response entry.
export interface Skill extends SkillInput {
  id: number;
  createdAt: string;
  updatedAt: string;
}

// Form state. Text controls and selects hold strings ("" = not specified);
// numbers are converted only when the form is submitted, so whatever the user
// typed is kept until then.
export interface SkillFormValues {
  name: string;
  experienceContexts: ExperienceContext[];
  practicalConfidence: string;
  interviewConfidence: string;
  experienceMonths: string;
  lastUsedYear: string;
  notes: string;
}

export type SkillFormField = keyof SkillFormValues;

export const SKILL_FORM_FIELDS: readonly SkillFormField[] = [
  "name",
  "experienceContexts",
  "practicalConfidence",
  "interviewConfidence",
  "experienceMonths",
  "lastUsedYear",
  "notes",
];

// Documented backend limits (backend/src/skill-validation.ts), used for
// display guidance only. The backend also caps lastUsedYear at the current
// UTC year.
export const SKILL_LIMITS = {
  name: 100,
  notes: 2_000,
  confidenceMin: 1,
  confidenceMax: 5,
  experienceMonthsMin: 0,
  experienceMonthsMax: 1200,
  lastUsedYearMin: 1950,
} as const;

export const EMPTY_SKILL_FORM: SkillFormValues = {
  name: "",
  experienceContexts: [],
  practicalConfidence: "",
  interviewConfidence: "",
  experienceMonths: "",
  lastUsedYear: "",
  notes: "",
};

const numberText = (value: number | null) => (value === null ? "" : String(value));

export function toSkillFormValues(skill: SkillInput | null): SkillFormValues {
  if (!skill) return { ...EMPTY_SKILL_FORM, experienceContexts: [] };
  return {
    name: skill.name,
    experienceContexts: [...skill.experienceContexts],
    practicalConfidence: numberText(skill.practicalConfidence),
    interviewConfidence: numberText(skill.interviewConfidence),
    experienceMonths: numberText(skill.experienceMonths),
    lastUsedYear: numberText(skill.lastUsedYear),
    notes: skill.notes ?? "",
  };
}

// Toggles one context, keeping the canonical EXPERIENCE_CONTEXTS order so the
// request never depends on click order.
export function toggleContext(
  selected: readonly ExperienceContext[],
  context: ExperienceContext,
  checked: boolean
): ExperienceContext[] {
  return EXPERIENCE_CONTEXTS.filter((c) => (c === context ? checked : selected.includes(c)));
}

// "" (or only spaces) -> null; "36" / " 36 " -> 36; anything else ("3.5",
// "-1", "1e3", "abc", "+2") is invalid. Range checks are left to the backend.
export function parseOptionalInteger(text: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!/^[0-9]+$/.test(trimmed)) return { ok: false };
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? { ok: true, value } : { ok: false };
}

export type SkillFieldErrors = Partial<Record<SkillFormField, string[]>>;

const NUMERIC_FIELDS = ["practicalConfidence", "interviewConfidence", "experienceMonths", "lastUsedYear"] as const;

// Blank text becomes null. Other whitespace normalization (name and notes) is
// left to the backend so there is a single source of truth.
function textOrNull(text: string): string | null {
  return text.trim() === "" ? null : text;
}

// Builds the request body from the form, or reports the numeric fields whose
// text is not a whole number. The typed values are not modified either way.
export function toSkillInput(
  values: SkillFormValues
): { ok: true; input: SkillInput } | { ok: false; fieldErrors: SkillFieldErrors } {
  const fieldErrors: SkillFieldErrors = {};
  const numbers: Partial<Record<(typeof NUMERIC_FIELDS)[number], number | null>> = {};
  for (const field of NUMERIC_FIELDS) {
    const parsed = parseOptionalInteger(values[field]);
    if (parsed.ok) numbers[field] = parsed.value;
    else fieldErrors[field] = ["Enter a whole number using digits only, or leave it blank."];
  }
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  return {
    ok: true,
    input: {
      name: values.name,
      experienceContexts: EXPERIENCE_CONTEXTS.filter((c) => values.experienceContexts.includes(c)),
      practicalConfidence: numbers.practicalConfidence ?? null,
      interviewConfidence: numbers.interviewConfidence ?? null,
      experienceMonths: numbers.experienceMonths ?? null,
      lastUsedYear: numbers.lastUsedYear ?? null,
      notes: textOrNull(values.notes),
    },
  };
}

const isNullableInteger = (value: unknown) => value === null || Number.isInteger(value);
const isDate = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value));

// Checks one skill in a response body. Returns undefined when it does not
// match the contract.
export function parseSkill(data: unknown): Skill | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const d = data as Record<string, unknown>;
  const contexts = d.experienceContexts;
  const valid =
    Number.isInteger(d.id) &&
    (d.id as number) > 0 &&
    typeof d.name === "string" &&
    Array.isArray(contexts) &&
    contexts.every((c, i) => (EXPERIENCE_CONTEXTS as readonly unknown[]).includes(c) && contexts.indexOf(c) === i) &&
    isNullableInteger(d.practicalConfidence) &&
    isNullableInteger(d.interviewConfidence) &&
    isNullableInteger(d.experienceMonths) &&
    isNullableInteger(d.lastUsedYear) &&
    (d.notes === null || typeof d.notes === "string") &&
    isDate(d.createdAt) &&
    isDate(d.updatedAt);
  if (!valid) return undefined;
  return {
    id: d.id as number,
    name: d.name as string,
    experienceContexts: [...(contexts as ExperienceContext[])],
    practicalConfidence: d.practicalConfidence as number | null,
    interviewConfidence: d.interviewConfidence as number | null,
    experienceMonths: d.experienceMonths as number | null,
    lastUsedYear: d.lastUsedYear as number | null,
    notes: d.notes as string | null,
    createdAt: d.createdAt as string,
    updatedAt: d.updatedAt as string,
  };
}

// Checks a GET /api/skills body. The server's order is kept as is: it sorts
// by the same normalized name the database compares, which a client-side
// sort could not reproduce exactly.
export function parseSkillList(data: unknown): Skill[] | undefined {
  if (!Array.isArray(data)) return undefined;
  const skills: Skill[] = [];
  for (const item of data) {
    const skill = parseSkill(item);
    if (!skill) return undefined;
    skills.push(skill);
  }
  return new Set(skills.map((s) => s.id)).size === skills.length ? skills : undefined;
}

const CONTEXT_ENTRY = /^experienceContexts\[(\d+)\]$/;

// Attach backend 400 details to form controls. experienceContexts[i] entries
// go to the experience-context group; anything that cannot be tied to a
// control (e.g. "body" or an unknown key) is returned as general.
export function groupSkillFieldErrors(details: readonly FieldErrorDetail[]): {
  fieldErrors: SkillFieldErrors;
  general: string[];
} {
  const fieldErrors: SkillFieldErrors = {};
  const general: string[] = [];
  for (const { field, message } of details) {
    const context = CONTEXT_ENTRY.exec(field);
    const target: SkillFormField | undefined = context
      ? "experienceContexts"
      : (SKILL_FORM_FIELDS as readonly string[]).includes(field)
        ? (field as SkillFormField)
        : undefined;
    if (!target) {
      general.push(`${field} ${message}.`);
      continue;
    }
    const text = context ? `Selection ${Number(context[1]) + 1} ${message}.` : `${capitalize(message)}.`;
    (fieldErrors[target] ??= []).push(text);
  }
  return { fieldErrors, general };
}

export function firstErrorField(errors: SkillFieldErrors): SkillFormField | undefined {
  return SKILL_FORM_FIELDS.find((field) => errors[field]);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// 0 -> "Less than a month", 14 -> "1 year 2 months", 24 -> "2 years".
export function formatExperience(months: number): string {
  if (months < 1) return "Less than a month";
  const years = Math.floor(months / 12);
  const rest = months % 12;
  const parts: string[] = [];
  if (years > 0) parts.push(`${years} ${years === 1 ? "year" : "years"}`);
  if (rest > 0) parts.push(`${rest} ${rest === 1 ? "month" : "months"}`);
  return parts.join(" ");
}

// Short facts shown under a skill's name, in a fixed order. Fields without a
// value are left out.
export function skillSummary(skill: SkillInput): string[] {
  const parts: string[] = [];
  if (skill.practicalConfidence !== null) parts.push(`Practical confidence ${skill.practicalConfidence}/5`);
  if (skill.interviewConfidence !== null) parts.push(`Interview confidence ${skill.interviewConfidence}/5`);
  if (skill.experienceMonths !== null) parts.push(`${formatExperience(skill.experienceMonths)} experience`);
  if (skill.lastUsedYear !== null) parts.push(`Last used ${skill.lastUsedYear}`);
  if (skill.experienceContexts.length > 0) {
    parts.push(skill.experienceContexts.map((c) => CONTEXT_LABELS[c]).join(", "));
  }
  return parts;
}

// Id of the row whose controls should take focus after the skill with this id
// disappears: the next one, else the previous one, else none.
export function neighborId(skills: readonly Skill[], id: number): number | null {
  const index = skills.findIndex((s) => s.id === id);
  if (index === -1) return null;
  return skills[index + 1]?.id ?? skills[index - 1]?.id ?? null;
}
