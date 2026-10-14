import {
  parseProfileResponse,
  type FieldErrorDetail,
  type Profile,
  type ProfileInput,
} from "./profile.ts";

// The two profile requests, using native fetch through the Vite /api proxy.
// Every outcome is returned as a typed result; only an abort (component
// unmounted or request superseded) is thrown, so callers can ignore it.

export type ApiFailure =
  | { kind: "validation"; details: FieldErrorDetail[] } // 400 validation_error
  | { kind: "bad_request" } // other 400 (e.g. invalid_json)
  | { kind: "too_large" } // 413
  | { kind: "unavailable" } // 503
  | { kind: "server" } // 500 and any other non-2xx
  | { kind: "network" } // fetch rejected: backend or proxy unreachable
  | { kind: "invalid_response" }; // 2xx with a body that breaks the contract

export type ApiResult<T> = { ok: true; data: T } | { ok: false; failure: ApiFailure };

const PROFILE_URL = "/api/profile";

async function readJson(res: Response, signal: AbortSignal | null | undefined): Promise<unknown> {
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

function failureFor(status: number, body: unknown): ApiFailure {
  if (status === 400) {
    const b = body as { error?: unknown; details?: unknown } | undefined;
    if (b?.error === "validation_error" && Array.isArray(b.details) && b.details.every(isFieldErrorDetail)) {
      return { kind: "validation", details: b.details };
    }
    return { kind: "bad_request" };
  }
  if (status === 413) return { kind: "too_large" };
  if (status === 503) return { kind: "unavailable" };
  return { kind: "server" };
}

async function request(init: RequestInit): Promise<ApiResult<Profile | null>> {
  let res: Response;
  try {
    res = await fetch(PROFILE_URL, init);
  } catch (err) {
    if (init.signal?.aborted) throw err;
    return { ok: false, failure: { kind: "network" } };
  }
  const body = await readJson(res, init.signal);
  if (!res.ok) return { ok: false, failure: failureFor(res.status, body) };

  const profile = parseProfileResponse(body);
  if (profile === undefined) return { ok: false, failure: { kind: "invalid_response" } };
  return { ok: true, data: profile };
}

export function fetchProfile(signal?: AbortSignal): Promise<ApiResult<Profile | null>> {
  return request({ method: "GET", headers: { accept: "application/json" }, signal });
}

export async function saveProfile(input: ProfileInput, signal?: AbortSignal): Promise<ApiResult<Profile>> {
  // Build the body from the six known keys only, so nothing else (id,
  // updatedAt, stray properties) can ever be sent.
  const body: ProfileInput = {
    headline: input.headline,
    experienceSummary: input.experienceSummary,
    location: input.location,
    targetRoles: input.targetRoles,
    workModel: input.workModel,
    careerInstructions: input.careerInstructions,
  };
  const result = await request({
    method: "PUT",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  // A successful PUT always returns the saved profile, never null.
  if (result.ok && result.data === null) return { ok: false, failure: { kind: "invalid_response" } };
  return result as ApiResult<Profile>;
}
