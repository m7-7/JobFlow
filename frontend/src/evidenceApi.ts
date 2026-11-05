import type { FieldErrorDetail } from "./profile.ts";
import { isApiTimestamp, isPositiveId, parseEvidence, parseEvidenceList, type Evidence, type EvidenceInput } from "./evidence.ts";

// The seven evidence requests, using native fetch through the Vite /api
// proxy. Every outcome is returned as a typed result; only an abort
// (component unmounted or request superseded) is thrown, so callers can
// ignore it. Writes are never retried automatically.
//
// Aborting a request only stops the browser waiting for it: a write the
// server already received may still be committed.

export type EvidenceApiFailure =
  | { kind: "validation"; details: FieldErrorDetail[] } // 400 validation_error
  | { kind: "bad_request" } // 400 invalid_json, invalid_id or bad_request, or a request refused before sending
  | { kind: "not_found" } // 404 not_found
  | { kind: "stale" } // 409 stale_evidence (review of an outdated version)
  | { kind: "too_large" } // 413
  | { kind: "unavailable" } // 503
  | { kind: "server" } // 500 and any other non-2xx
  | { kind: "network" } // fetch rejected: backend or proxy unreachable
  | { kind: "invalid_response" }; // 2xx with a body that breaks the contract

export type EvidenceApiResult<T> = { ok: true; data: T } | { ok: false; failure: EvidenceApiFailure };

const EVIDENCE_URL = "/api/evidence";

// True when a failed write may nevertheless have been committed: the server
// did not answer with a definite rejection. Callers must reconcile with the
// server instead of retrying automatically.
export function writeOutcomeUnknown(failure: EvidenceApiFailure): boolean {
  switch (failure.kind) {
    case "validation":
    case "bad_request":
    case "not_found":
    case "stale":
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

// 400 codes the backend sends only before any write: route validation
// (evidence-routes.ts) and body-parser errors (errors.ts).
const DEFINITE_400_CODES: readonly unknown[] = ["invalid_json", "invalid_id", "bad_request"];

// 400, 404 and 409 are only trusted when they carry the backend's own error
// code; a bare or malformed one (e.g. from a proxy) says nothing about the
// source and is reported as "server", an uncertain outcome.
function failureFor(status: number, body: unknown): EvidenceApiFailure {
  const b = body as { error?: unknown; details?: unknown } | undefined;
  if (status === 400) {
    if (b?.error === "validation_error" && Array.isArray(b.details) && b.details.every(isFieldErrorDetail)) {
      return { kind: "validation", details: b.details };
    }
    if (DEFINITE_400_CODES.includes(b?.error)) return { kind: "bad_request" };
    return { kind: "server" };
  }
  if (status === 404 && b?.error === "not_found") return { kind: "not_found" };
  if (status === 409 && b?.error === "stale_evidence") return { kind: "stale" };
  if (status === 413) return { kind: "too_large" };
  if (status === 503) return { kind: "unavailable" };
  return { kind: "server" };
}

async function request<T>(
  url: string,
  init: RequestInit & { signal?: AbortSignal },
  parse: ((body: unknown) => T | undefined) | null
): Promise<EvidenceApiResult<T>> {
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

// Build the body from the four content keys only, so nothing else (id,
// origin, reviewedAt, skillIds, stray properties) can ever be sent.
function contentBody(input: EvidenceInput): string {
  const body: EvidenceInput = {
    type: input.type,
    title: input.title,
    description: input.description,
    url: input.url,
  };
  return JSON.stringify(body);
}

const JSON_HEADERS = { "content-type": "application/json", accept: "application/json" };
const ACCEPT_JSON = { accept: "application/json" };
const REFUSED = { ok: false, failure: { kind: "bad_request" } } as const;

function evidenceUrl(id: number, suffix = ""): string | null {
  return isPositiveId(id) ? `${EVIDENCE_URL}/${id}${suffix}` : null;
}

export function fetchEvidenceList(signal?: AbortSignal): Promise<EvidenceApiResult<Evidence[]>> {
  return request(EVIDENCE_URL, { method: "GET", headers: ACCEPT_JSON, signal }, parseEvidenceList);
}

export async function fetchEvidence(id: number, signal?: AbortSignal): Promise<EvidenceApiResult<Evidence>> {
  const url = evidenceUrl(id);
  if (!url) return REFUSED;
  return request(url, { method: "GET", headers: ACCEPT_JSON, signal }, parseEvidence);
}

export function createEvidence(input: EvidenceInput, signal?: AbortSignal): Promise<EvidenceApiResult<Evidence>> {
  return request(EVIDENCE_URL, { method: "POST", headers: JSON_HEADERS, body: contentBody(input), signal }, parseEvidence);
}

// Full replacement of the content. A change clears the candidate's review on
// the server; an identical replacement leaves it as it was.
export async function replaceEvidence(
  id: number,
  input: EvidenceInput,
  signal?: AbortSignal
): Promise<EvidenceApiResult<Evidence>> {
  const url = evidenceUrl(id);
  if (!url) return REFUSED;
  return request(url, { method: "PUT", headers: JSON_HEADERS, body: contentBody(input), signal }, parseEvidence);
}

export async function deleteEvidence(id: number, signal?: AbortSignal): Promise<EvidenceApiResult<void>> {
  const url = evidenceUrl(id);
  if (!url) return REFUSED;
  return request<void>(url, { method: "DELETE", headers: ACCEPT_JSON, signal }, null);
}

// skillIds is the complete intended set; [] unlinks every skill. Ids that are
// not positive integers or repeat are refused before sending, so a mistaken
// payload never reaches the server.
export async function replaceEvidenceSkills(
  id: number,
  skillIds: readonly number[],
  signal?: AbortSignal
): Promise<EvidenceApiResult<Evidence>> {
  const url = evidenceUrl(id, "/skills");
  if (!url || !skillIds.every((s, i) => isPositiveId(s) && skillIds.indexOf(s) === i)) return REFUSED;
  const body = JSON.stringify({ skillIds: [...skillIds] });
  return request(url, { method: "PUT", headers: JSON_HEADERS, body, signal }, parseEvidence);
}

// Records that the candidate reviewed the version whose updatedAt is
// expectedUpdatedAt. A newer version answers "stale".
export async function reviewEvidence(
  id: number,
  expectedUpdatedAt: string,
  signal?: AbortSignal
): Promise<EvidenceApiResult<Evidence>> {
  const url = evidenceUrl(id, "/review");
  if (!url || !isApiTimestamp(expectedUpdatedAt)) return REFUSED;
  const body = JSON.stringify({ expectedUpdatedAt });
  return request(url, { method: "POST", headers: JSON_HEADERS, body, signal }, parseEvidence);
}
