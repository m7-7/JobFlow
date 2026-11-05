// API-layer tests with a stubbed global fetch (no server, no dependencies).
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createEvidence,
  deleteEvidence,
  fetchEvidence,
  fetchEvidenceList,
  replaceEvidence,
  replaceEvidenceSkills,
  reviewEvidence,
  writeOutcomeUnknown,
} from "./evidenceApi.ts";
import type { Evidence, EvidenceInput } from "./evidence.ts";

const input: EvidenceInput = {
  type: "professional_experience",
  title: "Backend engineer at Acme",
  description: null,
  url: "https://acme.example/",
};
const saved: Evidence = {
  ...input,
  id: 4,
  origin: "manual",
  reviewedAt: null,
  skillIds: [1, 3],
  createdAt: "2026-10-20T09:00:00.000Z",
  updatedAt: "2026-10-20T09:00:00.000Z",
};

const realFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit }[] = [];

function stubFetch(respond: (init: RequestInit) => Response | Promise<Response>) {
  calls = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond(init);
  }) as typeof fetch;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const failure = (kind: string) => ({ ok: false, failure: { kind } });
const sentBody = (i = 0) => JSON.parse(calls[i].init.body as string);

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("request paths, methods and bodies", () => {
  it("GET /api/evidence", async () => {
    stubFetch(() => json(200, [saved]));
    assert.deepEqual(await fetchEvidenceList(), { ok: true, data: [saved] });
    assert.equal(calls[0].url, "/api/evidence");
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.body, undefined);
  });

  it("GET /api/evidence/:id", async () => {
    stubFetch(() => json(200, saved));
    assert.deepEqual(await fetchEvidence(4), { ok: true, data: saved });
    assert.equal(calls[0].url, "/api/evidence/4");
    assert.equal(calls[0].init.method, "GET");
  });

  it("POST /api/evidence with exactly the four content fields", async () => {
    stubFetch(() => json(201, saved));
    const extra = { ...input, id: 9, origin: "manual", reviewedAt: "x", skillIds: [1], stray: true } as EvidenceInput;
    assert.deepEqual(await createEvidence(extra), { ok: true, data: saved });
    assert.equal(calls[0].url, "/api/evidence");
    assert.equal(calls[0].init.method, "POST");
    assert.equal((calls[0].init.headers as Record<string, string>)["content-type"], "application/json");
    assert.deepEqual(sentBody(), input);
  });

  it("PUT /api/evidence/:id with all four keys, nulls explicit", async () => {
    stubFetch(() => json(200, saved));
    await replaceEvidence(4, { ...input, url: null });
    assert.equal(calls[0].url, "/api/evidence/4");
    assert.equal(calls[0].init.method, "PUT");
    assert.equal(calls[0].init.body, JSON.stringify({ type: input.type, title: input.title, description: null, url: null }));
  });

  it("DELETE /api/evidence/:id and accepts 204 with no body", async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    assert.deepEqual(await deleteEvidence(4), { ok: true, data: undefined });
    assert.equal(calls[0].url, "/api/evidence/4");
    assert.equal(calls[0].init.method, "DELETE");
    assert.equal(calls[0].init.body, undefined);
  });

  it("PUT /api/evidence/:id/skills with the complete set, including []", async () => {
    stubFetch(() => json(200, saved));
    await replaceEvidenceSkills(4, [3, 1]);
    assert.equal(calls[0].url, "/api/evidence/4/skills");
    assert.equal(calls[0].init.method, "PUT");
    assert.deepEqual(sentBody(), { skillIds: [3, 1] });
    await replaceEvidenceSkills(4, []);
    assert.equal(calls[1].init.body, JSON.stringify({ skillIds: [] }));
  });

  it("POST /api/evidence/:id/review with the expectedUpdatedAt precondition only", async () => {
    const reviewed = { ...saved, reviewedAt: "2026-10-21T10:00:00.000Z" };
    stubFetch(() => json(200, reviewed));
    assert.deepEqual(await reviewEvidence(4, saved.updatedAt), { ok: true, data: reviewed });
    assert.equal(calls[0].url, "/api/evidence/4/review");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.body, JSON.stringify({ expectedUpdatedAt: "2026-10-20T09:00:00.000Z" }));
  });
});

describe("requests refused before sending", () => {
  it("refuses invalid ids", async () => {
    stubFetch(() => json(200, saved));
    for (const id of [0, -1, 1.5, Number.NaN, 2 ** 31]) {
      assert.deepEqual(await fetchEvidence(id), failure("bad_request"));
      assert.deepEqual(await replaceEvidence(id, input), failure("bad_request"));
      assert.deepEqual(await deleteEvidence(id), failure("bad_request"));
      assert.deepEqual(await replaceEvidenceSkills(id, []), failure("bad_request"));
      assert.deepEqual(await reviewEvidence(id, saved.updatedAt), failure("bad_request"));
    }
    assert.equal(calls.length, 0);
  });

  it("refuses malformed or repeated skill ids", async () => {
    stubFetch(() => json(200, saved));
    for (const ids of [[1, 1], [0], [1.5], [Number.NaN]]) {
      assert.deepEqual(await replaceEvidenceSkills(4, ids), failure("bad_request"));
    }
    assert.equal(calls.length, 0);
  });

  it("refuses a precondition not in the API's timestamp form", async () => {
    stubFetch(() => json(200, saved));
    for (const ts of ["", "2026-10-20T09:00:00Z", "2026-10-20T11:00:00.000+02:00", "yesterday"]) {
      assert.deepEqual(await reviewEvidence(4, ts), failure("bad_request"));
    }
    assert.equal(calls.length, 0);
  });
});

describe("failure mapping", () => {
  it("returns 400 validation details", async () => {
    const details = [{ field: "skillIds[0]", message: "does not refer to an existing skill" }];
    stubFetch(() => json(400, { error: "validation_error", message: "The skill links are invalid.", details }));
    assert.deepEqual(await replaceEvidenceSkills(4, [99]), { ok: false, failure: { kind: "validation", details } });
  });

  it("treats the backend's other 400 codes as definite bad_request", async () => {
    for (const error of ["invalid_json", "invalid_id", "bad_request"]) {
      stubFetch(() => json(400, { error, message: "…" }));
      const result = await createEvidence(input);
      assert.deepEqual(result, failure("bad_request"), error);
      assert.ok(!result.ok && !writeOutcomeUnknown(result.failure));
    }
  });

  it("treats a bare, unrecognized or malformed 400 as uncertain", async () => {
    const bodies = [
      () => new Response("Bad Request", { status: 400 }),
      () => new Response(null, { status: 400 }),
      () => json(400, {}),
      () => json(400, { error: "something_else", message: "…" }),
      () => json(400, { error: "validation_error", details: [{ field: 1 }] }),
      () => json(400, { error: "validation_error" }),
    ];
    for (const respond of bodies) {
      stubFetch(respond);
      const result = await replaceEvidence(4, input);
      assert.deepEqual(result, failure("server"));
      assert.ok(!result.ok && writeOutcomeUnknown(result.failure));
    }
  });

  it("maps 404 not_found only with the backend's code", async () => {
    stubFetch(() => json(404, { error: "not_found", message: "The evidence source was not found." }));
    assert.deepEqual(await replaceEvidence(4, input), failure("not_found"));
    assert.deepEqual(await replaceEvidenceSkills(4, [1]), failure("not_found"));
    assert.deepEqual(await deleteEvidence(4), failure("not_found"));
    stubFetch(() => new Response("Not Found", { status: 404 }));
    assert.deepEqual(await fetchEvidence(4), failure("server"));
  });

  it("maps 409 stale_evidence only with the backend's code", async () => {
    stubFetch(() => json(409, { error: "stale_evidence", message: "…" }));
    assert.deepEqual(await reviewEvidence(4, saved.updatedAt), failure("stale"));
    stubFetch(() => new Response("Conflict", { status: 409 }));
    assert.deepEqual(await reviewEvidence(4, saved.updatedAt), failure("server"));
  });

  it("maps 413, 503, 500, unexpected statuses and network failures", async () => {
    stubFetch(() => json(413, { error: "payload_too_large" }));
    assert.deepEqual(await createEvidence(input), failure("too_large"));
    stubFetch(() => json(503, { error: "database_unavailable" }));
    assert.deepEqual(await createEvidence(input), failure("unavailable"));
    stubFetch(() => json(500, { error: "internal_error" }));
    assert.deepEqual(await createEvidence(input), failure("server"));
    stubFetch(() => new Response("Bad Gateway", { status: 502 }));
    assert.deepEqual(await fetchEvidenceList(), failure("server"));
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    assert.deepEqual(await createEvidence(input), failure("network"));
  });

  it("reports a 2xx with an unexpected body as invalid_response", async () => {
    for (const body of [null, { evidence: [] }, [{ ...saved, origin: "imported" }]]) {
      stubFetch(() => json(200, body));
      assert.deepEqual(await fetchEvidenceList(), failure("invalid_response"));
    }
    stubFetch(() => json(201, { ...saved, updatedAt: null }));
    assert.deepEqual(await createEvidence(input), failure("invalid_response"));
    stubFetch(() => new Response("<html>not json</html>", { status: 200 }));
    assert.deepEqual(await reviewEvidence(4, saved.updatedAt), failure("invalid_response"));
  });
});

describe("abort", () => {
  it("rethrows when the caller aborts, instead of reporting a failure", async () => {
    stubFetch(
      (init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        })
    );
    for (const call of [
      (s: AbortSignal) => fetchEvidenceList(s),
      (s: AbortSignal) => fetchEvidence(4, s),
      (s: AbortSignal) => createEvidence(input, s),
      (s: AbortSignal) => replaceEvidence(4, input, s),
      (s: AbortSignal) => deleteEvidence(4, s),
      (s: AbortSignal) => replaceEvidenceSkills(4, [1], s),
      (s: AbortSignal) => reviewEvidence(4, saved.updatedAt, s),
    ]) {
      const controller = new AbortController();
      const pending = call(controller.signal);
      controller.abort();
      await assert.rejects(pending, { name: "AbortError" });
    }
  });

  it("sends a write only once, with the caller's signal", async () => {
    stubFetch(() => json(503, { error: "database_unavailable" }));
    const controller = new AbortController();
    await createEvidence(input, controller.signal);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.signal, controller.signal);
  });
});

describe("writeOutcomeUnknown", () => {
  it("is false only for definite rejections", () => {
    for (const kind of ["validation", "bad_request", "not_found", "stale", "too_large"] as const) {
      const f = kind === "validation" ? { kind, details: [] } : { kind };
      assert.equal(writeOutcomeUnknown(f), false, kind);
    }
    for (const kind of ["unavailable", "server", "network", "invalid_response"] as const) {
      assert.equal(writeOutcomeUnknown({ kind }), true, kind);
    }
  });
});
