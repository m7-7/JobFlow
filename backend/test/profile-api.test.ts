import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { assertNoSensitiveContent, captureConsoleError, listen, useDisposableTestDatabase } from "./helpers.js";

// Integration tests: real Express app + real PostgreSQL (disposable test
// database only, enforced by useDisposableTestDatabase).
useDisposableTestDatabase();

const { app } = await import("../src/app.js");
const { db } = await import("../src/db.js");
const { sql } = await import("drizzle-orm");
const { migrate } = await import("drizzle-orm/postgres-js/migrator");

const fullProfile = {
  headline: "Senior Backend Engineer",
  experienceSummary: "Ten years of TypeScript and PostgreSQL.\n\nLed a platform team.",
  location: "Athens, Greece",
  targetRoles: ["Backend Engineer", "Platform Engineer"],
  workModel: "hybrid",
  careerInstructions: "Prefer product companies; avoid agencies.",
};

const emptyProfile = {
  headline: null,
  experienceSummary: null,
  location: null,
  targetRoles: [],
  workModel: null,
  careerInstructions: null,
};

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

const put = (body: unknown) => request("PUT", "/profile", body);
const get = () => request("GET", "/profile");

async function rowCount(): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM candidate_profile`);
  return rows[0].n;
}

before(async () => {
  const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
  await migrate(db, { migrationsFolder });
  ({ baseUrl, close: closeServer } = await listen(app));
});

beforeEach(async () => {
  // Safe: this is the disposable test database (guarded above).
  await db.execute(sql`DELETE FROM candidate_profile`);
});

after(async () => {
  await closeServer();
  await db.$client.end();
});

describe("GET /profile", () => {
  it("returns 200 with null when no profile exists", async () => {
    const res = await get();
    assert.equal(res.status, 200);
    assert.equal(res.text, "null");
  });

  it("returns the persisted profile after a save", async () => {
    const saved = await put(fullProfile);
    const res = await get();
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, saved.json);
    assert.deepEqual(Object.keys(res.json).sort(), [...Object.keys(fullProfile), "updatedAt"].sort());
    assert.equal(res.json.id, undefined);
  });
});

describe("PUT /profile", () => {
  it("first PUT creates the singleton profile with id 1", async () => {
    assert.equal(await rowCount(), 0);
    const res = await put(fullProfile);
    assert.equal(res.status, 200);
    const { updatedAt, ...fields } = res.json;
    assert.deepEqual(fields, fullProfile);
    assert.ok(!Number.isNaN(Date.parse(updatedAt)));

    const rows = await db.execute<{ id: number; roles_type: string }>(
      sql`SELECT id, jsonb_typeof(target_roles) AS roles_type FROM candidate_profile`
    );
    assert.deepEqual([...rows], [{ id: 1, roles_type: "array" }]);
  });

  it("repeated PUTs update the same row, keep one row and refresh updated_at", async () => {
    assert.equal((await put(fullProfile)).status, 200);

    // Deterministic: pin the stored timestamp far in the past, then check the
    // next PUT replaces it. No sleeps, no reliance on the clock moving forward.
    const historical = "2000-01-01T00:00:00.000Z";
    await db.execute(sql`UPDATE candidate_profile SET updated_at = ${historical}::timestamptz`);
    assert.equal((await get()).json.updatedAt, historical);

    const second = await put({ ...fullProfile, headline: "Staff Engineer", workModel: "remote" });

    assert.equal(second.status, 200);
    assert.equal(second.json.headline, "Staff Engineer");
    assert.equal(second.json.workModel, "remote");
    assert.notEqual(second.json.updatedAt, historical);
    assert.equal((await get()).json.updatedAt, second.json.updatedAt);
    assert.equal(await rowCount(), 1);

    const rows = await db.execute<{ id: number }>(sql`SELECT id FROM candidate_profile`);
    assert.equal(rows[0].id, 1);
    assert.deepEqual((await get()).json, second.json);
  });

  it("concurrent first saves still produce exactly one row", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => put({ ...fullProfile, headline: `Concurrent ${i}` }))
    );
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(await rowCount(), 1);
  });

  it("supports partial completion with null fields", async () => {
    const partial = { ...emptyProfile, headline: "Backend Engineer", targetRoles: ["Backend Engineer"] };
    const res = await put(partial);
    assert.equal(res.status, 200);
    const { updatedAt: _u, ...fields } = res.json;
    assert.deepEqual(fields, partial);
  });

  it("accepts empty target roles and can clear a previously complete profile", async () => {
    await put(fullProfile);
    const res = await put(emptyProfile);
    assert.equal(res.status, 200);
    const { updatedAt: _u, ...fields } = res.json;
    assert.deepEqual(fields, emptyProfile);
    assert.deepEqual((await get()).json.targetRoles, []);
  });

  it("returns normalized values (trimmed, empty-to-null, deduplicated roles)", async () => {
    const res = await put({
      ...fullProfile,
      headline: "  Senior   Engineer ",
      location: "   ",
      targetRoles: ["Backend Engineer", " backend  engineer "],
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.headline, "Senior Engineer");
    assert.equal(res.json.location, null);
    assert.deepEqual(res.json.targetRoles, ["Backend Engineer"]);
  });
});

describe("PUT /profile validation (400)", () => {
  async function expect400(body: unknown, expectedFields: string[]) {
    const res = await put(body);
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "validation_error");
    assert.deepEqual(res.json.details.map((d: { field: string }) => d.field).sort(), [...expectedFields].sort());
    for (const d of res.json.details) assert.equal(typeof d.message, "string");
    assertNoSensitiveContent(res.text);
    assert.equal(await rowCount(), 0, "invalid input must not be persisted");
  }

  it("rejects an invalid work model", async () => {
    await expect400({ ...fullProfile, workModel: "office" }, ["workModel"]);
  });

  it("rejects invalid target role arrays", async () => {
    await expect400({ ...fullProfile, targetRoles: "Backend Engineer" }, ["targetRoles"]);
    await expect400({ ...fullProfile, targetRoles: ["ok", 3, "  "] }, ["targetRoles[1]", "targetRoles[2]"]);
    await expect400({ ...fullProfile, targetRoles: Array.from({ length: 21 }, (_, i) => `R${i}`) }, ["targetRoles"]);
  });

  it("rejects oversized text", async () => {
    await expect400({ ...fullProfile, experienceSummary: "x".repeat(10_001) }, ["experienceSummary"]);
    await expect400({ ...fullProfile, headline: "x".repeat(201) }, ["headline"]);
  });

  it("rejects missing and unknown fields, including id and updatedAt", async () => {
    const { careerInstructions: _c, ...missing } = fullProfile;
    await expect400(missing, ["careerInstructions"]);
    await expect400({ ...fullProfile, id: 2 }, ["id"]);
    await expect400({ ...fullProfile, updatedAt: "2000-01-01T00:00:00Z", extra: true }, ["updatedAt", "extra"]);
  });

  it("rejects non-object JSON bodies", async () => {
    await expect400([fullProfile], ["body"]);
    // Top-level primitives are refused earlier, by the strict JSON parser.
    const res = await request("PUT", "/profile", undefined, '"profile"');
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "invalid_json");
  });

  it("rejects a body that is not sent as JSON", async () => {
    const res = await fetch(`${baseUrl}/profile`, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(fullProfile),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).details[0].field, "body");
  });

  it("rejects malformed JSON with a safe message", async () => {
    const res = await request("PUT", "/profile", undefined, '{"headline": "x",');
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, { error: "invalid_json", message: "Request body must be a valid JSON object." });
    assertNoSensitiveContent(res.text, ["SyntaxError", "Unexpected"]);
  });

  it("rejects a body over the size limit with 413", async () => {
    const res = await request("PUT", "/profile", undefined, JSON.stringify({ ...fullProfile, headline: "x".repeat(200_000) }));
    assert.equal(res.status, 413);
    assert.equal(res.json.error, "payload_too_large");
    assert.equal(await rowCount(), 0);
  });
});

describe("database errors", () => {
  it("returns a generic 500 for an unexpected database error, without leaking or logging the payload", async () => {
    // Simulate an unexpected (non-connectivity) failure: the table is missing.
    // Runs inside the disposable test database and is restored afterwards.
    await db.execute(sql`ALTER TABLE candidate_profile RENAME TO candidate_profile_hidden`);
    const log = captureConsoleError();
    try {
      const secretMarker = "UNIQUE-PAYLOAD-MARKER-7f3a";
      const putRes = await put({ ...fullProfile, careerInstructions: secretMarker });
      const getRes = await get();

      for (const res of [putRes, getRes]) {
        assert.equal(res.status, 500);
        assert.deepEqual(res.json, { error: "internal_error", message: "An unexpected error occurred." });
        assertNoSensitiveContent(res.text, [secretMarker, "42P01", "relation"]);
      }
      assert.equal(log.lines.length, 2);
      assert.ok(log.lines.every((l) => l.endsWith("failed: database_error [42P01]")), "only category + SQLSTATE are logged");
      assert.ok(log.lines.every((l) => !l.includes("relation") && !l.includes("candidate_profile")), "raw driver message is not logged");
      assert.ok(log.lines.every((l) => !l.includes(secretMarker)), "payload is not logged");
      assert.ok(log.lines.every((l) => !l.includes("Senior Backend Engineer")), "payload is not logged");
    } finally {
      log.restore();
      await db.execute(sql`ALTER TABLE candidate_profile_hidden RENAME TO candidate_profile`);
    }
  });
});

describe("GET /health", () => {
  it("is unchanged: 200 with database connected", async () => {
    const res = await request("GET", "/health");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { status: "ok", db: "connected" });
  });
});
