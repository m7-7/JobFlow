// Candidate evidence sources: types, the editable source-content draft,
// response checks and skill-link helpers. No React, no fetch — unit-testable
// with node.
//
// A source has three separate parts, written by separate requests:
//  - source content (type, title, description, url): POST / PUT /evidence;
//  - skill links (skillIds): PUT /evidence/:id/skills, the complete set;
//  - the candidate's review (reviewedAt): POST /evidence/:id/review.
// reviewedAt means the candidate confirmed the current content; it is not
// independent verification and says nothing about the linked skills. Any
// content change clears it on the server; linking skills does not.
//
// The backend (backend/src/evidence-validation.ts) is authoritative for
// validation and normalization. The checks here mirror it for early feedback
// and so that an unchanged draft can be recognised without a request.

import type { FieldErrorDetail } from "./profile.ts";

export const EVIDENCE_SOURCE_TYPES = ["professional_experience", "personal_project", "cv", "portfolio", "other"] as const;
export type EvidenceSourceType = (typeof EVIDENCE_SOURCE_TYPES)[number];

export const SOURCE_TYPE_LABELS: Record<EvidenceSourceType, string> = {
  professional_experience: "Professional experience",
  personal_project: "Personal project",
  cv: "CV",
  portfolio: "Portfolio",
  other: "Other",
};

export const SOURCE_TYPE_OPTIONS: readonly { value: EvidenceSourceType; label: string }[] = EVIDENCE_SOURCE_TYPES.map(
  (value) => ({ value, label: SOURCE_TYPE_LABELS[value] })
);

// Every source is currently entered by hand; the API reports no other origin.
export const EVIDENCE_ORIGINS = ["manual"] as const;
export type EvidenceOrigin = (typeof EVIDENCE_ORIGINS)[number];

// POST/PUT /api/evidence request body: always all four content keys.
export interface EvidenceInput {
  type: EvidenceSourceType;
  title: string;
  description: string | null;
  url: string | null;
}

// GET/POST/PUT response entry. skillIds are ascending as sent by the server.
export interface Evidence extends EvidenceInput {
  id: number;
  origin: EvidenceOrigin;
  reviewedAt: string | null;
  skillIds: number[];
  createdAt: string;
  updatedAt: string;
}

// Form state for the source content only. Text controls hold strings ("" =
// not specified). Skill links and review state are deliberately not part of
// it.
export interface EvidenceDraft {
  type: EvidenceSourceType;
  title: string;
  description: string;
  url: string;
}

export type EvidenceDraftField = keyof EvidenceDraft;

export const EVIDENCE_DRAFT_FIELDS: readonly EvidenceDraftField[] = ["type", "title", "description", "url"];

// Documented backend limits (backend/src/evidence-validation.ts). Text is
// counted in code points after normalization; the url limit applies to the
// canonical form.
export const EVIDENCE_LIMITS = {
  title: 200,
  description: 5_000,
  url: 2_048,
  skillIds: 500,
} as const;

export const EMPTY_EVIDENCE_DRAFT: EvidenceDraft = { type: "professional_experience", title: "", description: "", url: "" };

export function toEvidenceDraft(evidence: EvidenceInput | null): EvidenceDraft {
  if (!evidence) return { ...EMPTY_EVIDENCE_DRAFT };
  return {
    type: evidence.type,
    title: evidence.title,
    description: evidence.description ?? "",
    url: evidence.url ?? "",
  };
}

export function sameContent(a: EvidenceInput, b: EvidenceInput): boolean {
  return a.type === b.type && a.title === b.title && a.description === b.description && a.url === b.url;
}

// ── Draft validation and normalization ──────────────────────────────────────

export type EvidenceFieldErrors = Partial<Record<EvidenceDraftField | "skillIds", string[]>>;

// Same character rules as the backend's shared text check.
const FORBIDDEN_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

// Title: runs of ASCII whitespace collapse to one space and the ends are
// trimmed; a title of nothing but Unicode whitespace is empty.
const ASCII_WHITESPACE_RUN = /[\t\n\v\f\r ]+/g;
const ONLY_WHITESPACE = /^[\p{White_Space}﻿]*$/u;

// URL: characters the WHATWG parser would strip or reinterpret, and the
// explicit scheme prefix the backend requires.
const URL_FORBIDDEN = /[\u0000- \u007F-\u009F\\]/;
const EXPLICIT_HTTP_PREFIX = /^https?:\/\//i;

function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function textProblem(raw: string): string | null {
  if (LONE_SURROGATE.test(raw)) return "Contains characters that are not valid text.";
  if (FORBIDDEN_CONTROL_CHARS.test(raw)) return "Must not contain control characters.";
  return null;
}

function normalizeTitle(raw: string, errors: string[]): string {
  const problem = textProblem(raw);
  if (problem) {
    errors.push(problem);
    return "";
  }
  const value = raw.replace(ASCII_WHITESPACE_RUN, " ").replace(/^ | $/g, "");
  if (ONLY_WHITESPACE.test(value)) {
    errors.push("Enter a title.");
    return "";
  }
  if (codePointLength(value) > EVIDENCE_LIMITS.title) {
    errors.push(`Use at most ${EVIDENCE_LIMITS.title} characters.`);
  }
  return value;
}

// Paragraphs and line breaks are kept; only the ends are trimmed and CRLF
// becomes LF. Blank means no description.
function normalizeDescription(raw: string, errors: string[]): string | null {
  const problem = textProblem(raw);
  if (problem) {
    errors.push(problem);
    return null;
  }
  const value = raw.replace(/\r\n?/g, "\n").trim();
  if (codePointLength(value) > EVIDENCE_LIMITS.description) {
    errors.push(`Use at most ${EVIDENCE_LIMITS.description} characters.`);
  }
  return value === "" ? null : value;
}

// The canonical WHATWG form, as the backend stores it. Never fetched.
function normalizeUrl(raw: string, errors: string[]): string | null {
  const problem = textProblem(raw);
  if (problem) {
    errors.push(problem);
    return null;
  }
  const value = raw.trim();
  if (value === "") return null;
  const invalid = () => {
    errors.push("Enter a full http:// or https:// address without a user name or password.");
    return null;
  };
  if (URL_FORBIDDEN.test(value) || !EXPLICIT_HTTP_PREFIX.test(value)) return invalid();
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
    errors.push(`Use at most ${EVIDENCE_LIMITS.url} characters.`);
  }
  return parsed.href;
}

export type DraftValidationResult =
  | {
      ok: true;
      // Sent to the server: the typed text, with blank optional fields as
      // null. The backend does its own normalization.
      input: EvidenceInput;
      // What the server is expected to store, for change detection only.
      normalized: EvidenceInput;
    }
  | { ok: false; fieldErrors: EvidenceFieldErrors };

// Checks a draft against the backend rules. The typed values are never
// modified; the backend's answer still decides.
export function validateEvidenceDraft(draft: EvidenceDraft): DraftValidationResult {
  const fieldErrors: EvidenceFieldErrors = {};
  const collect = <T>(field: EvidenceDraftField, check: (errors: string[]) => T): T => {
    const errors: string[] = [];
    const value = check(errors);
    if (errors.length > 0) fieldErrors[field] = errors;
    return value;
  };

  const type = collect("type", (errors) => {
    if (!(EVIDENCE_SOURCE_TYPES as readonly string[]).includes(draft.type)) errors.push("Choose a source type.");
    return draft.type;
  });
  const title = collect("title", (errors) => normalizeTitle(draft.title, errors));
  const description = collect("description", (errors) => normalizeDescription(draft.description, errors));
  const url = collect("url", (errors) => normalizeUrl(draft.url, errors));

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  return {
    ok: true,
    input: {
      type,
      title: draft.title,
      description: draft.description.trim() === "" ? null : draft.description,
      url: draft.url.trim() === "" ? null : draft.url,
    },
    normalized: { type, title, description, url },
  };
}

// ── Skill links ─────────────────────────────────────────────────────────────

// The complete set of linked skill ids, ascending and without repeats, the
// form the server reports and a stable form to compare.
export function normalizeSkillIds(ids: readonly number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

export function sameSkillIds(a: readonly number[], b: readonly number[]): boolean {
  const x = normalizeSkillIds(a);
  const y = normalizeSkillIds(b);
  return x.length === y.length && x.every((id, i) => id === y[i]);
}

export function toggleSkillId(selected: readonly number[], id: number, checked: boolean): number[] {
  const rest = selected.filter((s) => s !== id);
  return normalizeSkillIds(checked ? [...rest, id] : rest);
}

export const isPositiveId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 2_147_483_647;

// ── Response checks ─────────────────────────────────────────────────────────

// The exact form the API serializes timestamps in (Date#toISOString). A
// review precondition must echo updatedAt in this form, so nothing else is
// accepted.
const API_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isApiTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    API_TIMESTAMP.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

const isNullableString = (value: unknown) => value === null || typeof value === "string";

// Checks one evidence source in a response body. Returns undefined when it
// does not match the contract.
export function parseEvidence(data: unknown): Evidence | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const d = data as Record<string, unknown>;
  const skillIds = d.skillIds;
  const valid =
    isPositiveId(d.id) &&
    (EVIDENCE_SOURCE_TYPES as readonly unknown[]).includes(d.type) &&
    typeof d.title === "string" &&
    isNullableString(d.description) &&
    isNullableString(d.url) &&
    (EVIDENCE_ORIGINS as readonly unknown[]).includes(d.origin) &&
    (d.reviewedAt === null || isApiTimestamp(d.reviewedAt)) &&
    Array.isArray(skillIds) &&
    skillIds.every((id, i) => isPositiveId(id) && skillIds.indexOf(id) === i) &&
    isApiTimestamp(d.createdAt) &&
    isApiTimestamp(d.updatedAt);
  if (!valid) return undefined;
  return {
    id: d.id as number,
    type: d.type as EvidenceSourceType,
    title: d.title as string,
    description: d.description as string | null,
    url: d.url as string | null,
    origin: d.origin as EvidenceOrigin,
    reviewedAt: d.reviewedAt as string | null,
    skillIds: normalizeSkillIds(skillIds as number[]),
    createdAt: d.createdAt as string,
    updatedAt: d.updatedAt as string,
  };
}

// Checks a GET /api/evidence body. The server's order (newest first) is kept.
export function parseEvidenceList(data: unknown): Evidence[] | undefined {
  if (!Array.isArray(data)) return undefined;
  const list: Evidence[] = [];
  for (const item of data) {
    const evidence = parseEvidence(item);
    if (!evidence) return undefined;
    list.push(evidence);
  }
  return new Set(list.map((e) => e.id)).size === list.length ? list : undefined;
}

// ── Backend error details ───────────────────────────────────────────────────

const SKILL_ENTRY = /^skillIds\[(\d+)\]$/;

// Attach backend 400 details to form controls. skillIds and skillIds[i] go to
// the skill-link group; anything else that cannot be tied to a control (e.g.
// "body" or an unknown key) is returned as general.
export function groupEvidenceFieldErrors(details: readonly FieldErrorDetail[]): {
  fieldErrors: EvidenceFieldErrors;
  general: string[];
} {
  const fieldErrors: EvidenceFieldErrors = {};
  const general: string[] = [];
  for (const { field, message } of details) {
    const entry = SKILL_ENTRY.exec(field);
    const target: keyof EvidenceFieldErrors | undefined =
      entry || field === "skillIds"
        ? "skillIds"
        : (EVIDENCE_DRAFT_FIELDS as readonly string[]).includes(field)
          ? (field as EvidenceDraftField)
          : undefined;
    if (!target) {
      general.push(`${field} ${message}.`);
      continue;
    }
    const text = entry ? `Selection ${Number(entry[1]) + 1} ${message}.` : `${capitalize(message)}.`;
    (fieldErrors[target] ??= []).push(text);
  }
  return { fieldErrors, general };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
