// API-layer tests with a stubbed global fetch (no server, no dependencies).
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchProfile, saveProfile } from "./profileApi.ts";
import type { ProfileInput } from "./profile.ts";

const input: ProfileInput = {
  headline: "Senior Backend Engineer",
  experienceSummary: null,
  location: "Athens",
  targetRoles: ["Backend Engineer"],
  workModel: "remote",
  careerInstructions: null,
};
const saved = { ...input, updatedAt: "2026-10-14T09:17:41.404Z" };

const realFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit }[] = [];

function stubFetch(respond: () => Response | Promise<Response>) {
  calls = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond();
  }) as typeof fetch;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchProfile", () => {
  it("GETs the browser-facing /api/profile route", async () => {
    stubFetch(() => json(200, null));
    await fetchProfile();
    assert.equal(calls[0].url, "/api/profile");
    assert.equal(calls[0].init.method, "GET");
  });

  it("returns null when no profile exists", async () => {
    stubFetch(() => json(200, null));
    assert.deepEqual(await fetchProfile(), { ok: true, data: null });
  });

  it("returns an existing profile", async () => {
    stubFetch(() => json(200, saved));
    assert.deepEqual(await fetchProfile(), { ok: true, data: saved });
  });

  it("reports a malformed 200 body as invalid_response", async () => {
    stubFetch(() => json(200, { headline: 1 }));
    assert.deepEqual(await fetchProfile(), { ok: false, failure: { kind: "invalid_response" } });
    stubFetch(() => new Response("<html>not json</html>", { status: 200 }));
    assert.deepEqual(await fetchProfile(), { ok: false, failure: { kind: "invalid_response" } });
  });

  it("maps 503, 500, other non-2xx and network failures", async () => {
    stubFetch(() => json(503, { error: "database_unavailable", message: "x" }));
    assert.deepEqual(await fetchProfile(), { ok: false, failure: { kind: "unavailable" } });
    stubFetch(() => json(500, { error: "internal_error", message: "x" }));
    assert.deepEqual(await fetchProfile(), { ok: false, failure: { kind: "server" } });
    stubFetch(() => new Response("Bad Gateway", { status: 502 }));
    assert.deepEqual(await fetchProfile(), { ok: false, failure: { kind: "server" } });
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    assert.deepEqual(await fetchProfile(), { ok: false, failure: { kind: "network" } });
  });

  it("throws (rather than returning a result) when aborted", async () => {
    const controller = new AbortController();
    stubFetch(() => {
      controller.abort();
      return Promise.reject(new DOMException("aborted", "AbortError"));
    });
    await assert.rejects(fetchProfile(controller.signal));
  });
});

describe("saveProfile", () => {
  it("PUTs exactly the six contract keys as JSON", async () => {
    stubFetch(() => json(200, saved));
    // Extra properties on the input object must not leak into the body.
    await saveProfile({ ...input, id: 7, updatedAt: "x" } as ProfileInput);
    assert.equal(calls[0].url, "/api/profile");
    assert.equal(calls[0].init.method, "PUT");
    assert.equal(new Headers(calls[0].init.headers).get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(calls[0].init.body as string), input);
  });

  it("returns the persisted profile on success", async () => {
    stubFetch(() => json(200, { ...saved, headline: "Normalized" }));
    assert.deepEqual(await saveProfile(input), { ok: true, data: { ...saved, headline: "Normalized" } });
  });

  it("treats a null 200 response to PUT as invalid", async () => {
    stubFetch(() => json(200, null));
    assert.deepEqual(await saveProfile(input), { ok: false, failure: { kind: "invalid_response" } });
  });

  it("returns backend field validation details for 400 validation_error", async () => {
    const details = [{ field: "workModel", message: "must be one of remote, hybrid, onsite, flexible, or null" }];
    stubFetch(() => json(400, { error: "validation_error", message: "The profile is invalid.", details }));
    assert.deepEqual(await saveProfile(input), { ok: false, failure: { kind: "validation", details } });
  });

  it("maps other 400s, 413, 500, 503 and network failures", async () => {
    stubFetch(() => json(400, { error: "invalid_json", message: "x" }));
    assert.deepEqual(await saveProfile(input), { ok: false, failure: { kind: "bad_request" } });
    stubFetch(() => json(400, { error: "validation_error", details: "nope" }));
    assert.deepEqual(await saveProfile(input), { ok: false, failure: { kind: "bad_request" } });
    stubFetch(() => json(413, { error: "payload_too_large", message: "x" }));
    assert.deepEqual(await saveProfile(input), { ok: false, failure: { kind: "too_large" } });
    stubFetch(() => json(500, { error: "internal_error", message: "x" }));
    assert.deepEqual(await saveProfile(input), { ok: false, failure: { kind: "server" } });
    stubFetch(() => json(503, { error: "database_unavailable", message: "x" }));
    assert.deepEqual(await saveProfile(input), { ok: false, failure: { kind: "unavailable" } });
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    assert.deepEqual(await saveProfile(input), { ok: false, failure: { kind: "network" } });
  });
});
