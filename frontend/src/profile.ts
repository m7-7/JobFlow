// Candidate profile: types and pure conversions between the API shape and the
// form's editable text values. No React, no fetch — unit-testable with node.
//
// The backend is authoritative for validation and normalization; the helpers
// here only convert shapes and provide display guidance.

export const WORK_MODELS = ["remote", "hybrid", "onsite", "flexible"] as const;
export type WorkModel = (typeof WORK_MODELS)[number];

// PUT /api/profile request body: always all six keys, never id/updatedAt.
export interface ProfileInput {
  headline: string | null;
  experienceSummary: string | null;
  location: string | null;
  targetRoles: string[];
  workModel: WorkModel | null;
  careerInstructions: string | null;
}

// GET/PUT /api/profile response.
export interface Profile extends ProfileInput {
  updatedAt: string;
}

// Form state: every control holds a string. workModel "" = not specified.
export interface FormValues {
  headline: string;
  experienceSummary: string;
  location: string;
  targetRoles: string;
  workModel: WorkModel | "";
  careerInstructions: string;
}

export type FormField = keyof FormValues;

export const FORM_FIELDS: readonly FormField[] = [
  "headline",
  "experienceSummary",
  "location",
  "targetRoles",
  "workModel",
  "careerInstructions",
];

// Documented backend limits (backend/src/profile-validation.ts), used for
// display guidance only.
export const LIMITS = {
  headline: 200,
  location: 200,
  experienceSummary: 10_000,
  careerInstructions: 5_000,
  targetRolesCount: 20,
  targetRoleLength: 100,
} as const;

// Counts Unicode code points, matching how the backend counts.
export function characterCount(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

// "Backend Engineer, Platform Engineer" -> ["Backend Engineer", "Platform Engineer"].
// Blank entries (e.g. a trailing comma) are dropped. Role names therefore
// cannot contain commas.
export function parseTargetRoles(text: string): string[] {
  return text
    .split(",")
    .map((role) => role.trim())
    .filter((role) => role !== "");
}

export function formatTargetRoles(roles: readonly string[]): string {
  return roles.join(", ");
}

export function toFormValues(profile: ProfileInput | null): FormValues {
  return {
    headline: profile?.headline ?? "",
    experienceSummary: profile?.experienceSummary ?? "",
    location: profile?.location ?? "",
    targetRoles: formatTargetRoles(profile?.targetRoles ?? []),
    workModel: profile?.workModel ?? "",
    careerInstructions: profile?.careerInstructions ?? "",
  };
}

// Blank text becomes null. Other whitespace normalization is left to the
// backend so there is a single source of truth.
function textOrNull(text: string): string | null {
  return text.trim() === "" ? null : text;
}

export function toProfileInput(values: FormValues): ProfileInput {
  return {
    headline: textOrNull(values.headline),
    experienceSummary: textOrNull(values.experienceSummary),
    location: textOrNull(values.location),
    targetRoles: parseTargetRoles(values.targetRoles),
    workModel: values.workModel === "" ? null : values.workModel,
    careerInstructions: textOrNull(values.careerInstructions),
  };
}

// After a successful save, take the server's normalized value for each field
// the user did not touch while the request was in flight; keep any field they
// edited meanwhile so no typing is lost.
export function mergeSavedValues(
  current: FormValues,
  submitted: FormValues,
  saved: FormValues
): FormValues {
  const merged = { ...current };
  for (const field of FORM_FIELDS) {
    if (current[field] === submitted[field]) {
      (merged as Record<FormField, string>)[field] = saved[field];
    }
  }
  return merged;
}

export function formValuesEqual(a: FormValues, b: FormValues): boolean {
  return FORM_FIELDS.every((field) => a[field] === b[field]);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

// Checks a GET/PUT response body. Returns null for "no profile yet" and
// undefined when the body does not match the contract.
export function parseProfileResponse(data: unknown): Profile | null | undefined {
  if (data === null) return null;
  if (typeof data !== "object" || Array.isArray(data)) return undefined;
  const d = data as Record<string, unknown>;
  const valid =
    isNullableString(d.headline) &&
    isNullableString(d.experienceSummary) &&
    isNullableString(d.location) &&
    isNullableString(d.careerInstructions) &&
    Array.isArray(d.targetRoles) &&
    d.targetRoles.every((role) => typeof role === "string") &&
    (d.workModel === null || (WORK_MODELS as readonly unknown[]).includes(d.workModel)) &&
    typeof d.updatedAt === "string" &&
    !Number.isNaN(Date.parse(d.updatedAt));
  if (!valid) return undefined;
  return {
    headline: d.headline as string | null,
    experienceSummary: d.experienceSummary as string | null,
    location: d.location as string | null,
    targetRoles: d.targetRoles as string[],
    workModel: d.workModel as WorkModel | null,
    careerInstructions: d.careerInstructions as string | null,
    updatedAt: d.updatedAt as string,
  };
}

// Backend 400 detail entry: { field: "workModel" | "targetRoles[2]" | "body" | ..., message }.
export interface FieldErrorDetail {
  field: string;
  message: string;
}

export type FieldErrors = Partial<Record<FormField, string[]>>;

const ROLE_ENTRY = /^targetRoles\[(\d+)\]$/;

// Attach backend errors to form controls. Entries for targetRoles[i] are
// shown on the target-roles control, naming the 1-based role position.
// Anything that cannot be tied to a control is returned as general.
export function groupFieldErrors(details: readonly FieldErrorDetail[]): {
  fieldErrors: FieldErrors;
  general: string[];
} {
  const fieldErrors: FieldErrors = {};
  const general: string[] = [];
  for (const { field, message } of details) {
    const role = ROLE_ENTRY.exec(field);
    const target: FormField | undefined = role
      ? "targetRoles"
      : (FORM_FIELDS as readonly string[]).includes(field)
        ? (field as FormField)
        : undefined;
    if (!target) {
      general.push(`${field} ${message}.`);
      continue;
    }
    const text = role ? `Role ${Number(role[1]) + 1} ${message}.` : `${capitalize(message)}.`;
    (fieldErrors[target] ??= []).push(text);
  }
  return { fieldErrors, general };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
