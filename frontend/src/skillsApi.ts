import type { FieldErrorDetail } from "./profile.ts";
import { parseSkill, parseSkillList, type Skill, type SkillInput } from "./skill.ts";

// The four skills requests, using native fetch through the Vite /api proxy.
// Every outcome is returned as a typed result; only an abort (component
// unmounted or request superseded) is thrown, so callers can ignore it.
//
// Aborting a request only stops the browser waiting for it: a write the
// server already received may still be committed.

export type SkillApiFailure =
  | { kind: "validation"; details: FieldErrorDetail[] } // 400 validation_error
  | { kind: "bad_request" } // other 400 (invalid_json, invalid_id)
  | { kind: "not_found" } // 404 not_found
  | { kind: "duplicate" } // 409 duplicate_skill
  | { kind: "too_large" } // 413
  | { kind: "unavailable" } // 503
  | { kind: "server" } // 500 and any other non-2xx
  | { kind: "network" } // fetch rejected: backend or proxy unreachable
  | { kind: "invalid_response" }; // 2xx with a body that breaks the contract

export type SkillApiResult<T> = { ok: true; data: T } | { ok: false; failure: SkillApiFailure };

const SKILLS_URL = "/api/skills";

// True when a failed write may nevertheless have been committed: the server
// did not answer with a definite rejection. Callers must reconcile with the
// server instead of retrying automatically.
export function writeOutcomeUnknown(failure: SkillApiFailure): boolean {
  switch (failure.kind) {
    case "validation":
    case "bad_request":
    case "not_found":
    case "duplicate":
    case "too_large":
      return false;
    case "unavailable":
    case "server":
    case "network":
    case "invalid_response":
      return true;
  }
}

async function readJson(res: Response, signal: AbortSignal | undefined): Promise<unknown> {
  try {
    return await res.json();
  } catch (err) {
    if (signal?.aborted) throw err;
    return undefined;
  }
}

function isFieldErrorDetail(value: unknown): value is FieldErrorDetail {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as FieldErrorDetail).field === "string" &&
    typeof (value as FieldErrorDetail).message === "string"
  );
}

// 404 and 409 are only trusted when they carry the backend's own error code;
// a bare 404/409 (e.g. from a proxy) says nothing about the skill.
function failureFor(status: number, body: unknown): SkillApiFailure {
  const b = body as { error?: unknown; details?: unknown } | undefined;
  if (status === 400) {
    if (b?.error === "validation_error" && Array.isArray(b.details) && b.details.every(isFieldErrorDetail)) {
      return { kind: "validation", details: b.details };
    }
    return { kind: "bad_request" };
  }
  if (status === 404 && b?.error === "not_found") return { kind: "not_found" };
  if (status === 409 && b?.error === "duplicate_skill") return { kind: "duplicate" };
  if (status === 413) return { kind: "too_large" };
  if (status === 503) return { kind: "unavailable" };
  return { kind: "server" };
}

async function request<T>(
  url: string,
  init: RequestInit & { signal?: AbortSignal },
  parse: ((body: unknown) => T | undefined) | null
): Promise<SkillApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (init.signal?.aborted) throw err;
    return { ok: false, failure: { kind: "network" } };
  }
  // DELETE success has no body to read.
  if (res.ok && parse === null) return { ok: true, data: undefined as T };
  const body = await readJson(res, init.signal);
  if (!res.ok) return { ok: false, failure: failureFor(res.status, body) };
  const data = parse!(body);
  if (data === undefined) return { ok: false, failure: { kind: "invalid_response" } };
  return { ok: true, data };
}

// Build the body from the seven writable keys only, so nothing else (id,
// timestamps, stray properties) can ever be sent.
function bodyFor(input: SkillInput): string {
  const body: SkillInput = {
    name: input.name,
    experienceContexts: input.experienceContexts,
    practicalConfidence: input.practicalConfidence,
    interviewConfidence: input.interviewConfidence,
    experienceMonths: input.experienceMonths,
    lastUsedYear: input.lastUsedYear,
    notes: input.notes,
  };
  return JSON.stringify(body);
}

const JSON_HEADERS = { "content-type": "application/json", accept: "application/json" };

function skillUrl(id: number): string | null {
  return Number.isSafeInteger(id) && id > 0 ? `${SKILLS_URL}/${id}` : null;
}

export function fetchSkills(signal?: AbortSignal): Promise<SkillApiResult<Skill[]>> {
  return request(SKILLS_URL, { method: "GET", headers: { accept: "application/json" }, signal }, parseSkillList);
}

export function createSkill(input: SkillInput, signal?: AbortSignal): Promise<SkillApiResult<Skill>> {
  return request(SKILLS_URL, { method: "POST", headers: JSON_HEADERS, body: bodyFor(input), signal }, parseSkill);
}

export async function replaceSkill(id: number, input: SkillInput, signal?: AbortSignal): Promise<SkillApiResult<Skill>> {
  const url = skillUrl(id);
  if (!url) return { ok: false, failure: { kind: "bad_request" } };
  return request(url, { method: "PUT", headers: JSON_HEADERS, body: bodyFor(input), signal }, parseSkill);
}

export async function deleteSkill(id: number, signal?: AbortSignal): Promise<SkillApiResult<void>> {
  const url = skillUrl(id);
  if (!url) return { ok: false, failure: { kind: "bad_request" } };
  return request<void>(url, { method: "DELETE", headers: { accept: "application/json" }, signal }, null);
}
