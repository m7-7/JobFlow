import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { assertNoSensitiveContent, captureConsoleError, listen, useDisposableTestDatabase } from "./helpers.js";

// Integration tests: real Express app + real PostgreSQL. Like the skill schema
// tests, they create and drop their own database on the disposable server named
// by TEST_DATABASE_URL (guarded by useDisposableTestDatabase), so they never
// share tables with the profile API tests running in parallel.
useDisposableTestDatabase();

const serverUrl = new URL(process.env.TEST_DATABASE_URL!);
const dbName = `${serverUrl.pathname.slice(1)}_skillapi_${process.pid}_test`;
const dbUrl = new URL(serverUrl);
dbUrl.pathname = `/${dbName}`;
// db.ts reads DATABASE_URL when first imported, below.
process.env.DATABASE_URL = dbUrl.href;

const admin = postgres(serverUrl.href, { max: 1, onnotice: () => {} });

const { app } = await import("../src/app.js");
const { db } = await import("../src/db.js");
const { sql } = await import("drizzle-orm");
const { migrate } = await import("drizzle-orm/postgres-js/migrator");

const fullSkill = {
  name: "PostgreSQL",
  experienceContexts: ["professional", "personal_project"],
  practicalConfidence: 4,
  interviewConfidence: 3,
  experienceMonths: 36,
  lastUsedYear: 2024,
  notes: "Schema design and query tuning.\n\nSome replication.",
};

const clearedFields = {
  experienceContexts: [],
  practicalConfidence: null,
  interviewConfidence: null,
  experienceMonths: null,
  lastUsedYear: null,
  notes: null,
};

const RESPONSE_KEYS = ["id", ...Object.keys(fullSkill), "createdAt", "updatedAt"].sort();
const DUPLICATE_BODY = { error: "duplicate_skill", message: "A skill with this name already exists." };
const NOT_FOUND_BODY = { error: "not_found", message: "The skill was not found." };
const INVALID_ID_BODY = { error: "invalid_id", message: "The skill id must be a positive integer." };
const CURRENT_YEAR = new Date().getUTCFullYear();

let baseUrl = "";
let closeServer = async () => {};

async function request(method: string, path: string, body?: unknown, rawBody?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined || rawBody !== undefined ? { "content-type": "application/json" } : {},
    body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

const list = () => request("GET", "/skills");
const post = (body: unknown) => request("POST", "/skills", body);
const put = (id: number | string, body: unknown) => request("PUT", `/skills/${id}`, body);
const del = (id: number | string) => request("DELETE", `/skills/${id}`);

async function created(body: unknown) {
  const res = await post(body);
  assert.equal(res.status, 201, res.text);
  return res.json;
}

async function rowCount(): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM candidate_skill`);
  return rows[0].n;
}

async function pinTimestamps(id: number, createdAt: string, updatedAt: string) {
  await db.execute(
    sql`UPDATE candidate_skill SET created_at = ${createdAt}::timestamptz, updated_at = ${updatedAt}::timestamptz WHERE id = ${id}`
  );
}

before(async () => {
  await admin`DROP DATABASE IF EXISTS ${admin(dbName)} WITH (FORCE)`;
  await admin`CREATE DATABASE ${admin(dbName)}`;
  const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
  await migrate(db, { migrationsFolder });
  ({ baseUrl, close: closeServer } = await listen(app));
});

// Runs even when tests or setup fail, so the per-run database never lingers.
// The DROP is attempted even if closing the server or app client fails.
after(async () => {
  try {
    await closeServer();
    await db.$client.end();
  } finally {
    try {
      await admin`DROP DATABASE IF EXISTS ${admin(dbName)} WITH (FORCE)`;
    } finally {
      await admin.end();
    }
  }
});

beforeEach(async () => {
  // Safe: this file's own database on the disposable server (guarded above).
  // candidate_skill_evidence references candidate_skill, so it is truncated with it.
  await db.execute(sql`TRUNCATE candidate_skill_evidence, candidate_skill RESTART IDENTITY`);
  await db.execute(sql`DELETE FROM candidate_profile`);
});

describe("GET /skills", () => {
  it("returns 200 with an empty array when there are no skills", async () => {
    const res = await list();
    assert.equal(res.status, 200);
    assert.equal(res.text, "[]");
  });

  it("lists every skill ordered by normalized name, then id", async () => {
    for (const name of ["delta", "Bravo", "alpha", "Charlie"]) await created({ name });
    // A row whose stored name has leading ASCII whitespace (the API never
    // stores one) still sorts by its normalized form.
    await db.execute(sql`INSERT INTO candidate_skill (name) VALUES (${"\t  Beta"})`);
    const res = await list();
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.json.map((s: { name: string }) => s.name),
      ["alpha", "\t  Beta", "Bravo", "Charlie", "delta"]
    );
    // Deterministic across calls.
    assert.deepEqual((await list()).json, res.json);
  });

  it("returns the full camelCase representation of each skill", async () => {
    const saved = await created(fullSkill);
    const res = await list();
    assert.deepEqual(res.json, [saved]);
    assert.deepEqual(Object.keys(res.json[0]).sort(), RESPONSE_KEYS);
  });
});

describe("POST /skills", () => {
  it("creates a skill from a name alone, with defaults, and returns 201", async () => {
    const res = await post({ name: "TypeScript" });
    assert.equal(res.status, 201);
    const { id, createdAt, updatedAt, ...fields } = res.json;
    assert.deepEqual(fields, { name: "TypeScript", ...clearedFields });
    assert.ok(Number.isInteger(id) && id > 0);
    assert.ok(!Number.isNaN(Date.parse(createdAt)));
    assert.equal(updatedAt, createdAt);
    assert.deepEqual(Object.keys(res.json).sort(), RESPONSE_KEYS);

    const rows = await db.execute<{ contexts_type: string }>(
      sql`SELECT jsonb_typeof(experience_contexts) AS contexts_type FROM candidate_skill`
    );
    assert.deepEqual([...rows], [{ contexts_type: "array" }]);
  });

  it("stores every field and returns them", async () => {
    const res = await post(fullSkill);
    assert.equal(res.status, 201);
    const { id: _i, createdAt: _c, updatedAt: _u, ...fields } = res.json;
    assert.deepEqual(fields, fullSkill);
    assert.deepEqual((await list()).json, [res.json]);
  });

  it("accepts the boundary values, including the current UTC year", async () => {
    const res = await post({
      name: "x".repeat(100),
      experienceContexts: ["professional", "personal_project", "academic", "learning"],
      practicalConfidence: 5,
      interviewConfidence: 1,
      experienceMonths: 1200,
      lastUsedYear: CURRENT_YEAR,
      notes: "n".repeat(2000),
    });
    assert.equal(res.status, 201, res.text);
    const low = await post({ name: "é".repeat(100), experienceMonths: 0, lastUsedYear: 1950 });
    assert.equal(low.status, 201, low.text);
  });

  it("collapses ASCII whitespace in the name but keeps other whitespace", async () => {
    assert.equal((await created({ name: "  Machine\t\tLearning \n" })).name, "Machine Learning");
    assert.equal((await created({ name: "Type Script" })).name, "Type Script");
  });

  it("rejects a client-supplied id", async () => {
    const res = await post({ name: "Go", id: 99 });
    assert.equal(res.status, 400);
    assert.equal(await rowCount(), 0);
  });
});

describe("duplicate names (409)", () => {
  it("rejects names equal after case folding and ASCII whitespace normalization", async () => {
    await created({ name: "TypeScript" });
    await created({ name: "Machine Learning" });
    const log = captureConsoleError();
    try {
      for (const name of ["typescript", "TYPESCRIPT", "  TypeScript", "\tTypeScript\n", "machine  learning", " MACHINE \r\n LEARNING "]) {
        const res = await post({ name });
        assert.equal(res.status, 409, name);
        assert.deepEqual(res.json, DUPLICATE_BODY);
        assertNoSensitiveContent(res.text, ["candidate_skill", "23505", "typescript", "learning"]);
      }
      assert.deepEqual(log.lines, [], "a duplicate is a client error and is not logged");
    } finally {
      log.restore();
    }
    assert.equal(await rowCount(), 2);
  });

  it("keeps genuinely different names apart", async () => {
    await created({ name: "TypeScript" });
    for (const name of ["Type Script", "Type Script", "TypeScripts", " TypeScript"]) {
      assert.equal((await post({ name })).status, 201, JSON.stringify(name));
    }
  });

  it("allows exactly one of many concurrent POSTs of the same skill", async () => {
    const variants = Array.from({ length: 12 }, (_, i) => ({ name: i % 2 ? ` rust${" ".repeat(i)}` : "RUST" }));
    const results = await Promise.all(variants.map((v) => post(v)));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, ...Array(11).fill(409)]);
    for (const r of results.filter((r) => r.status === 409)) assert.deepEqual(r.json, DUPLICATE_BODY);
    assert.equal(await rowCount(), 1);
  });

  it("rejects a PUT that renames a skill onto another skill's name, leaving both unchanged", async () => {
    await created({ name: "Go" });
    const rust = await created({ name: "Rust" });
    const res = await put(rust.id, { name: " go ", ...clearedFields });
    assert.equal(res.status, 409);
    assert.deepEqual(res.json, DUPLICATE_BODY);
    assert.deepEqual(
      (await list()).json.map((s: { name: string }) => s.name),
      ["Go", "Rust"]
    );
  });

  it("allows a PUT that changes only the display form of the same skill", async () => {
    const rust = await created({ name: "Rust" });
    const res = await put(rust.id, { name: "RUST", ...clearedFields });
    assert.equal(res.status, 200);
    assert.equal(res.json.name, "RUST");
  });

  it("lets a deleted skill's name be used again", async () => {
    const go = await created({ name: "Go" });
    assert.equal((await del(go.id)).status, 204);
    assert.equal((await post({ name: "go" })).status, 201);
  });
});

describe("PUT /skills/:id", () => {
  it("replaces every field, keeps id and createdAt, and refreshes updatedAt", async () => {
    const skill = await created({ name: "Postgres" });
    // Deterministic: pin both timestamps in the past instead of sleeping.
    const historical = "2000-01-01T00:00:00.000Z";
    await pinTimestamps(skill.id, historical, historical);

    const res = await put(skill.id, fullSkill);
    assert.equal(res.status, 200);
    const { id, createdAt, updatedAt, ...fields } = res.json;
    assert.deepEqual(fields, fullSkill);
    assert.equal(id, skill.id);
    assert.equal(createdAt, historical);
    assert.notEqual(updatedAt, historical);
    assert.ok(Date.parse(updatedAt) > Date.parse(historical));
    assert.deepEqual((await list()).json, [res.json]);
  });

  it("refreshes updatedAt even when the replacement is identical", async () => {
    const skill = await created(fullSkill);
    const historical = "2001-02-03T04:05:06.000Z";
    await pinTimestamps(skill.id, historical, historical);

    const res = await put(skill.id, fullSkill);
    assert.equal(res.status, 200);
    assert.equal(res.json.createdAt, historical);
    assert.notEqual(res.json.updatedAt, historical);
  });

  it("clears optional values with explicit null and []", async () => {
    const skill = await created(fullSkill);
    const res = await put(skill.id, { name: "PostgreSQL", ...clearedFields });
    assert.equal(res.status, 200);
    const { id: _i, createdAt: _c, updatedAt: _u, ...fields } = res.json;
    assert.deepEqual(fields, { name: "PostgreSQL", ...clearedFields });
  });

  it("rejects omitted fields instead of clearing stored data", async () => {
    const skill = await created(fullSkill);
    const before = (await list()).json;
    const { notes: _n, experienceMonths: _e, ...partial } = fullSkill;
    const res = await put(skill.id, partial);
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "validation_error");
    assert.deepEqual(res.json.details.map((d: { field: string }) => d.field).sort(), ["experienceMonths", "notes"]);
    assert.deepEqual((await list()).json, before);
  });

  it("rejects unknown fields, including id and timestamps", async () => {
    const skill = await created(fullSkill);
    const res = await put(skill.id, { ...fullSkill, id: 5, createdAt: "2000-01-01T00:00:00Z", updatedAt: "2000-01-01T00:00:00Z" });
    assert.equal(res.status, 400);
    assert.deepEqual(res.json.details.map((d: { field: string }) => d.field).sort(), ["createdAt", "id", "updatedAt"]);
  });

  it("returns 404 for a well-formed id with no skill", async () => {
    const skill = await created({ name: "Go" });
    for (const id of [skill.id + 1, 2147483647]) {
      const res = await put(id, { name: "Rust", ...clearedFields });
      assert.equal(res.status, 404);
      assert.deepEqual(res.json, NOT_FOUND_BODY);
    }
    assert.equal(await rowCount(), 1, "a missing id never creates a row");
  });
});

describe("DELETE /skills/:id", () => {
  it("deletes the skill and returns 204 with no body", async () => {
    const go = await created({ name: "Go" });
    const rust = await created({ name: "Rust" });
    const res = await fetch(`${baseUrl}/skills/${go.id}`, { method: "DELETE" });
    assert.equal(res.status, 204);
    assert.equal(await res.text(), "");
    assert.equal(res.headers.get("content-type"), null);
    assert.deepEqual((await list()).json, [rust]);
  });

  it("returns 404 for a well-formed id with no skill, including one already deleted", async () => {
    const go = await created({ name: "Go" });
    assert.equal((await del(go.id)).status, 204);
    for (const id of [go.id, 2147483647]) {
      const res = await del(id);
      assert.equal(res.status, 404);
      assert.deepEqual(res.json, NOT_FOUND_BODY);
    }
  });
});

describe("invalid ids (400)", () => {
  const invalidIds = ["0", "00", "01", "-1", "+1", "1.0", "1.5", "1e3", "0x1", "%201", "1%20", "abc", "1a", "2147483648", "99999999999", "1".repeat(300)];

  it("PUT and DELETE reject non-canonical or out-of-range ids before touching the database", async () => {
    const skill = await created({ name: "Go" });
    for (const id of invalidIds) {
      for (const res of [await put(id, { name: "Rust", ...clearedFields }), await del(id)]) {
        assert.equal(res.status, 400, id);
        assert.deepEqual(res.json, INVALID_ID_BODY);
      }
    }
    assert.deepEqual((await list()).json, [skill]);
  });

  it("an invalid id is reported before body validation", async () => {
    const res = await put("abc", { bogus: true });
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, INVALID_ID_BODY);
  });
});

describe("POST and PUT validation (400)", () => {
  async function expect400(send: () => Promise<{ status: number; text: string; json: any }>, expectedFields: string[]) {
    const res = await send();
    assert.equal(res.status, 400, res.text);
    assert.equal(res.json.error, "validation_error");
    assert.equal(res.json.message, "The skill is invalid.");
    assert.deepEqual(res.json.details.map((d: { field: string }) => d.field).sort(), [...expectedFields].sort());
    for (const d of res.json.details) assert.equal(typeof d.message, "string");
    assertNoSensitiveContent(res.text, ["candidate_skill"]);
  }

  const invalidCases: [string, Record<string, unknown>, string[]][] = [
    ["null name", { name: null }, ["name"]],
    ["non-string name", { name: 7 }, ["name"]],
    ["blank name", { name: " \t\n " }, ["name"]],
    ["Unicode-whitespace-only name", { name: "  　" }, ["name"]],
    ["U+0085-only name", { name: " \u0085 " }, ["name"]],
    ["101-character name", { name: "x".repeat(101) }, ["name"]],
    ["control character in name", { name: "Go\u0000" }, ["name"]],
    ["lone surrogate in name", { name: "Go\uD800" }, ["name"]],
    ["null experienceContexts", { experienceContexts: null }, ["experienceContexts"]],
    ["string experienceContexts", { experienceContexts: "professional" }, ["experienceContexts"]],
    ["unknown context", { experienceContexts: ["work"] }, ["experienceContexts[0]"]],
    ["duplicate context", { experienceContexts: ["academic", "academic"] }, ["experienceContexts[1]"]],
    ["confidence 0", { practicalConfidence: 0 }, ["practicalConfidence"]],
    ["confidence 6", { interviewConfidence: 6 }, ["interviewConfidence"]],
    ["fractional confidence", { practicalConfidence: 2.5 }, ["practicalConfidence"]],
    ["string confidence", { interviewConfidence: "3" }, ["interviewConfidence"]],
    ["negative months", { experienceMonths: -1 }, ["experienceMonths"]],
    ["1201 months", { experienceMonths: 1201 }, ["experienceMonths"]],
    ["year 1949", { lastUsedYear: 1949 }, ["lastUsedYear"]],
    ["next year", { lastUsedYear: CURRENT_YEAR + 1 }, ["lastUsedYear"]],
    ["year 2101", { lastUsedYear: 2101 }, ["lastUsedYear"]],
    ["boolean year", { lastUsedYear: true }, ["lastUsedYear"]],
    ["2001-character notes", { notes: "x".repeat(2001) }, ["notes"]],
    ["non-string notes", { notes: ["x"] }, ["notes"]],
    ["unknown keys", { level: 3, createdAt: "2000-01-01T00:00:00Z" }, ["level", "createdAt"]],
  ];

  for (const [label, patch, expectedFields] of invalidCases) {
    it(`rejects ${label}`, async () => {
      await expect400(() => post({ name: "Go", ...patch }), expectedFields);
      assert.equal(await rowCount(), 0, "invalid input must not be persisted");

      const skill = await created(fullSkill);
      await expect400(() => put(skill.id, { ...fullSkill, ...patch }), expectedFields);
      assert.deepEqual((await list()).json, [skill], "invalid input must not change the skill");
    });
  }

  it("rejects a create without a name", async () => {
    await expect400(() => post({ notes: "x" }), ["name"]);
    await expect400(() => post({}), ["name"]);
  });

  it("rejects non-object JSON bodies", async () => {
    const skill = await created({ name: "Go" });
    await expect400(() => post([{ name: "Rust" }]), ["body"]);
    await expect400(() => put(skill.id, [fullSkill]), ["body"]);
    // Top-level primitives are refused earlier, by the strict JSON parser.
    for (const res of [await request("POST", "/skills", undefined, '"Rust"'), await request("PUT", `/skills/${skill.id}`, undefined, "null")]) {
      assert.equal(res.status, 400);
      assert.equal(res.json.error, "invalid_json");
    }
  });

  it("rejects a body that is not sent as JSON", async () => {
    const res = await fetch(`${baseUrl}/skills`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ name: "Go" }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).details[0].field, "body");
    assert.equal(await rowCount(), 0);
  });

  it("rejects malformed JSON with a safe message", async () => {
    const skill = await created({ name: "Go" });
    for (const res of [
      await request("POST", "/skills", undefined, '{"name": "Rust",'),
      await request("PUT", `/skills/${skill.id}`, undefined, "{name: 'Rust'}"),
    ]) {
      assert.equal(res.status, 400);
      assert.deepEqual(res.json, { error: "invalid_json", message: "Request body must be a valid JSON object." });
      assertNoSensitiveContent(res.text, ["SyntaxError", "Unexpected"]);
    }
  });

  it("rejects a body over the 128 kB limit with 413", async () => {
    const skill = await created({ name: "Go" });
    const huge = JSON.stringify({ ...fullSkill, notes: "x".repeat(200_000) });
    for (const res of [await request("POST", "/skills", undefined, huge), await request("PUT", `/skills/${skill.id}`, undefined, huge)]) {
      assert.equal(res.status, 413);
      assert.deepEqual(res.json, { error: "payload_too_large", message: "Request body is too large." });
    }
    assert.deepEqual((await list()).json, [skill]);
  });
});

describe("database errors", () => {
  it("returns a generic 500 for an unexpected database error, without leaking or logging skill content", async () => {
    const skill = await created({ name: "Go" });
    // Simulate an unexpected (non-connectivity) failure: the table is missing.
    // Runs inside this file's own database and is restored afterwards.
    await db.execute(sql`ALTER TABLE candidate_skill RENAME TO candidate_skill_hidden`);
    const log = captureConsoleError();
    try {
      const secret = "UNIQUE-SKILL-MARKER-91e4";
      const responses = [
        await list(),
        await post({ name: secret, notes: secret }),
        await put(skill.id, { ...fullSkill, name: secret, notes: secret }),
        await del(skill.id),
      ];
      for (const res of responses) {
        assert.equal(res.status, 500);
        assert.deepEqual(res.json, { error: "internal_error", message: "An unexpected error occurred." });
        assertNoSensitiveContent(res.text, [secret, "42P01", "relation", "candidate_skill"]);
      }
      assert.deepEqual(log.lines, [
        "GET /skills failed: database_error [42P01]",
        "POST /skills failed: database_error [42P01]",
        `PUT /skills/${skill.id} failed: database_error [42P01]`,
        `DELETE /skills/${skill.id} failed: database_error [42P01]`,
      ]);
      for (const line of log.lines) {
        for (const marker of [secret, "relation", "candidate_skill", "Postgre", "Schema design"]) {
          assert.ok(!line.includes(marker), `log leaked ${JSON.stringify(marker)}`);
        }
      }
    } finally {
      log.restore();
      await db.execute(sql`ALTER TABLE candidate_skill_hidden RENAME TO candidate_skill`);
    }
  });
});

describe("candidate profile is unaffected", () => {
  it("skill operations leave the profile as saved, and the profile API still works", async () => {
    const profile = {
      headline: "Backend Engineer",
      experienceSummary: null,
      location: null,
      targetRoles: ["Backend Engineer"],
      workModel: "remote",
      careerInstructions: null,
    };
    const saved = await request("PUT", "/profile", profile);
    assert.equal(saved.status, 200);

    const skill = await created(fullSkill);
    assert.equal((await put(skill.id, { ...fullSkill, name: "Postgres" })).status, 200);
    assert.equal((await post({ name: "postgres" })).status, 409);
    assert.equal((await del(skill.id)).status, 204);

    const after = await request("GET", "/profile");
    assert.equal(after.status, 200);
    assert.deepEqual(after.json, saved.json);
  });

  it("GET /health is unchanged", async () => {
    const res = await request("GET", "/health");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { status: "ok", db: "connected" });
  });
});
