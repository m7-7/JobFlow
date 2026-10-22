// API-layer tests with a stubbed global fetch (no server, no dependencies).
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSkill, deleteSkill, fetchSkills, replaceSkill, writeOutcomeUnknown } from "./skillsApi.ts";
import type { Skill, SkillInput } from "./skill.ts";

const input: SkillInput = {
  name: "PostgreSQL",
  experienceContexts: ["professional"],
  practicalConfidence: 4,
  interviewConfidence: 3,
  experienceMonths: 36,
  lastUsedYear: 2024,
  notes: null,
};
const saved: Skill = {
  ...input,
  id: 5,
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

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchSkills", () => {
  it("GETs /api/skills", async () => {
    stubFetch(() => json(200, []));
    assert.deepEqual(await fetchSkills(), { ok: true, data: [] });
    assert.equal(calls[0].url, "/api/skills");
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.body, undefined);
  });

  it("returns skills in the order the server sent them", async () => {
    const list = [
      { ...saved, id: 9, name: "zsh" },
      { ...saved, id: 2, name: "Ada" },
    ];
    stubFetch(() => json(200, list));
    const result = await fetchSkills();
    assert.ok(result.ok);
    assert.deepEqual(
      result.data.map((s) => s.id),
      [9, 2]
    );
  });

  it("reports a malformed 200 body as invalid_response", async () => {
    for (const body of [null, { skills: [] }, [{ ...saved, id: "5" }]]) {
      stubFetch(() => json(200, body));
      assert.deepEqual(await fetchSkills(), failure("invalid_response"));
    }
    stubFetch(() => new Response("<html>not json</html>", { status: 200 }));
    assert.deepEqual(await fetchSkills(), failure("invalid_response"));
  });

  it("maps 503, 500, unexpected statuses and network failures", async () => {
    stubFetch(() => json(503, { error: "database_unavailable", message: "…" }));
    assert.deepEqual(await fetchSkills(), failure("unavailable"));
    stubFetch(() => json(500, { error: "internal_error", message: "…" }));
    assert.deepEqual(await fetchSkills(), failure("server"));
    stubFetch(() => new Response("Bad Gateway", { status: 502 }));
    assert.deepEqual(await fetchSkills(), failure("server"));
    stubFetch(() => new Response("Not Found", { status: 404 }));
    assert.deepEqual(await fetchSkills(), failure("server"));
    stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    assert.deepEqual(await fetchSkills(), failure("network"));
  });
});

describe("createSkill", () => {
  it("POSTs exactly the seven writable fields as JSON", async () => {
    stubFetch(() => json(201, saved));
    const extra = { ...input, id: 99, createdAt: "x", updatedAt: "y", stray: true } as SkillInput;
    assert.deepEqual(await createSkill(extra), { ok: true, data: saved });
    assert.equal(calls[0].url, "/api/skills");
    assert.equal(calls[0].init.method, "POST");
    assert.equal((calls[0].init.headers as Record<string, string>)["content-type"], "application/json");
    assert.deepEqual(JSON.parse(calls[0].init.body as string), input);
  });

  it("sends zero contexts and null values explicitly", async () => {
    stubFetch(() => json(201, saved));
    const minimal: SkillInput = {
      name: "Go",
      experienceContexts: [],
      practicalConfidence: null,
      interviewConfidence: null,
      experienceMonths: null,
      lastUsedYear: null,
      notes: null,
    };
    await createSkill(minimal);
    assert.equal(calls[0].init.body, JSON.stringify(minimal));
  });

  it("returns 400 validation details", async () => {
    const details = [{ field: "name", message: "must not be empty" }];
    stubFetch(() => json(400, { error: "validation_error", message: "The skill is invalid.", details }));
    assert.deepEqual(await createSkill(input), { ok: false, failure: { kind: "validation", details } });
  });

  it("treats other or malformed 400 bodies as bad_request", async () => {
    stubFetch(() => json(400, { error: "invalid_json", message: "…" }));
    assert.deepEqual(await createSkill(input), failure("bad_request"));
    stubFetch(() => json(400, { error: "validation_error", details: [{ field: 1 }] }));
    assert.deepEqual(await createSkill(input), failure("bad_request"));
  });

  it("maps 409 duplicate_skill, but not a bare 409", async () => {
    stubFetch(() => json(409, { error: "duplicate_skill", message: "A skill with this name already exists." }));
    assert.deepEqual(await createSkill(input), failure("duplicate"));
    stubFetch(() => new Response("Conflict", { status: 409 }));
    assert.deepEqual(await createSkill(input), failure("server"));
  });

  it("maps 413, 503, 500 and network failures", async () => {
    stubFetch(() => json(413, { error: "payload_too_large", message: "…" }));
    assert.deepEqual(await createSkill(input), failure("too_large"));
    stubFetch(() => json(503, { error: "database_unavailable" }));
    assert.deepEqual(await createSkill(input), failure("unavailable"));
    stubFetch(() => json(500, { error: "internal_error" }));
    assert.deepEqual(await createSkill(input), failure("server"));
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    assert.deepEqual(await createSkill(input), failure("network"));
  });

  it("reports a 201 with a malformed body as invalid_response", async () => {
    stubFetch(() => json(201, { ...saved, createdAt: null }));
    assert.deepEqual(await createSkill(input), failure("invalid_response"));
  });
});

describe("replaceSkill", () => {
  it("PUTs all seven fields to /api/skills/:id", async () => {
    stubFetch(() => json(200, saved));
    assert.deepEqual(await replaceSkill(5, input), { ok: true, data: saved });
    assert.equal(calls[0].url, "/api/skills/5");
    assert.equal(calls[0].init.method, "PUT");
    assert.deepEqual(Object.keys(JSON.parse(calls[0].init.body as string)), [
      "name",
      "experienceContexts",
      "practicalConfidence",
      "interviewConfidence",
      "experienceMonths",
      "lastUsedYear",
      "notes",
    ]);
  });

  it("maps 404 not_found, 409 duplicate and 400 validation", async () => {
    stubFetch(() => json(404, { error: "not_found", message: "The skill was not found." }));
    assert.deepEqual(await replaceSkill(5, input), failure("not_found"));
    stubFetch(() => json(409, { error: "duplicate_skill" }));
    assert.deepEqual(await replaceSkill(5, input), failure("duplicate"));
    const details = [{ field: "experienceContexts[0]", message: "must be one of …" }];
    stubFetch(() => json(400, { error: "validation_error", details }));
    assert.deepEqual(await replaceSkill(5, input), { ok: false, failure: { kind: "validation", details } });
  });

  it("does not trust a 404 without the backend's error code", async () => {
    stubFetch(() => new Response("Not Found", { status: 404 }));
    assert.deepEqual(await replaceSkill(5, input), failure("server"));
  });

  it("refuses an invalid id without sending a request", async () => {
    stubFetch(() => json(200, saved));
    for (const id of [0, -1, 1.5, Number.NaN]) {
      assert.deepEqual(await replaceSkill(id, input), failure("bad_request"));
    }
    assert.equal(calls.length, 0);
  });
});

describe("deleteSkill", () => {
  it("DELETEs /api/skills/:id and accepts 204 with no body", async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    assert.deepEqual(await deleteSkill(5), { ok: true, data: undefined });
    assert.equal(calls[0].url, "/api/skills/5");
    assert.equal(calls[0].init.method, "DELETE");
    assert.equal(calls[0].init.body, undefined);
  });

  it("maps 404 not_found, 503, 500 and network failures", async () => {
    stubFetch(() => json(404, { error: "not_found" }));
    assert.deepEqual(await deleteSkill(5), failure("not_found"));
    stubFetch(() => json(503, { error: "database_unavailable" }));
    assert.deepEqual(await deleteSkill(5), failure("unavailable"));
    stubFetch(() => json(500, { error: "internal_error" }));
    assert.deepEqual(await deleteSkill(5), failure("server"));
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    assert.deepEqual(await deleteSkill(5), failure("network"));
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
      (s: AbortSignal) => fetchSkills(s),
      (s: AbortSignal) => createSkill(input, s),
      (s: AbortSignal) => replaceSkill(5, input, s),
      (s: AbortSignal) => deleteSkill(5, s),
    ]) {
      const controller = new AbortController();
      const pending = call(controller.signal);
      controller.abort();
      await assert.rejects(pending, { name: "AbortError" });
    }
  });

  it("passes the signal to fetch", async () => {
    stubFetch(() => json(200, []));
    const controller = new AbortController();
    await fetchSkills(controller.signal);
    assert.equal(calls[0].init.signal, controller.signal);
  });
});

describe("writeOutcomeUnknown", () => {
  it("is false only for definite rejections", () => {
    for (const kind of ["validation", "bad_request", "not_found", "duplicate", "too_large"] as const) {
      const f = kind === "validation" ? { kind, details: [] } : { kind };
      assert.equal(writeOutcomeUnknown(f), false, kind);
    }
    for (const kind of ["unavailable", "server", "network", "invalid_response"] as const) {
      assert.equal(writeOutcomeUnknown({ kind }), true, kind);
    }
  });
});
