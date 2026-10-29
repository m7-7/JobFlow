import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { assertNoSensitiveContent, captureConsoleError, listen, useDisposableTestDatabase } from "./helpers.js";

// Integration tests: real Express app + real PostgreSQL. Like the skills API
// tests, they create and drop their own database on the disposable server
// named by TEST_DATABASE_URL (guarded by useDisposableTestDatabase).
useDisposableTestDatabase();

const serverUrl = new URL(process.env.TEST_DATABASE_URL!);
const dbName = `${serverUrl.pathname.slice(1)}_evidenceapi_${process.pid}_test`;
const dbUrl = new URL(serverUrl);
dbUrl.pathname = `/${dbName}`;
// db.ts reads DATABASE_URL when first imported, below.
process.env.DATABASE_URL = dbUrl.href;

const admin = postgres(serverUrl.href, { max: 1, onnotice: () => {} });
// A separate client for direct SQL: fixtures, assertions and the transactions
// the concurrency tests hold open while the API waits on their locks.
const pg = postgres(dbUrl.href, { max: 4, onnotice: () => {} });

const { app } = await import("../src/app.js");
const { db } = await import("../src/db.js");
const { migrate } = await import("drizzle-orm/postgres-js/migrator");

const RESPONSE_KEYS = ["id", "type", "title", "description", "url", "origin", "reviewedAt", "skillIds", "createdAt", "updatedAt"].sort();
const NOT_FOUND_BODY = { error: "not_found", message: "The evidence source was not found." };
const INVALID_ID_BODY = { error: "invalid_id", message: "The evidence id must be a positive integer." };
const STALE_BODY = {
  error: "stale_evidence",
  message: "The evidence source has changed since it was loaded. Reload it and review again.",
};

const fullSource = {
  type: "personal_project",
  title: "JobFlow",
  description: "Local job-search tool.\n\nExpress + React.",
  url: "https://example.com/project",
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

const list = () => request("GET", "/evidence");
const get = (id: number | string) => request("GET", `/evidence/${id}`);
const post = (body: unknown) => request("POST", "/evidence", body);
const put = (id: number | string, body: unknown) => request("PUT", `/evidence/${id}`, body);
const del = (id: number | string) => request("DELETE", `/evidence/${id}`);
const putSkills = (id: number | string, skillIds: unknown) => request("PUT", `/evidence/${id}/skills`, { skillIds });
const review = (id: number | string, expectedUpdatedAt: unknown) =>
  request("POST", `/evidence/${id}/review`, { expectedUpdatedAt });

async function created(body: unknown = fullSource) {
  const res = await post(body);
  assert.equal(res.status, 201, res.text);
  return res.json;
}

async function ok(res: Promise<{ status: number; text: string; json: any }>, status = 200) {
  const r = await res;
  assert.equal(r.status, status, r.text);
  return r.json;
}

async function skill(name: string): Promise<number> {
  const res = await request("POST", "/skills", { name });
  assert.equal(res.status, 201, res.text);
  return res.json.id;
}

async function links(): Promise<[number, number][]> {
  const rows = await pg`SELECT skill_id, evidence_source_id FROM candidate_skill_evidence ORDER BY 1, 2`;
  return rows.map((r) => [r.skill_id as number, r.evidence_source_id as number]);
}

class Rollback extends Error {}

// Transactions opened by hold() and not yet ended. afterEach rolls them back,
// so a failing concurrency test cannot leave locks behind and hang the file.
const held = new Set<{ rollback: () => Promise<void> }>();

// Opens a transaction on the direct client, runs `statements` in it and keeps
// it open (with its locks) until commit() or rollback() is called.
async function hold(statements: (t: postgres.TransactionSql) => Promise<unknown>) {
  let decide!: (commit: boolean) => void;
  const decision = new Promise<boolean>((resolve) => (decide = resolve));
  let ready!: () => void;
  let failed!: (err: unknown) => void;
  const started = new Promise<void>((resolve, reject) => ((ready = resolve), (failed = reject)));
  const done = pg
    .begin(async (t) => {
      await statements(t);
      ready();
      if (!(await decision)) throw new Rollback();
    })
    .catch((err) => {
      failed(err);
      if (!(err instanceof Rollback)) throw err;
    });
  await started;
  const handle = {
    commit: async () => (held.delete(handle), decide(true), await done),
    rollback: async () => (held.delete(handle), decide(false), await done),
  };
  held.add(handle);
  return handle;
}

// Waits until `count` sessions in this file's database are blocked on a lock.
// Polls PostgreSQL's own view of the waiters, so it does not depend on timing.
async function lockWaiters(count: number) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [{ n }] = await pg`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (n >= count) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} lock waiter(s); saw ${n}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

before(async () => {
  await admin`DROP DATABASE IF EXISTS ${admin(dbName)} WITH (FORCE)`;
  await admin`CREATE DATABASE ${admin(dbName)}`;
  const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
  await migrate(db, { migrationsFolder });
  ({ baseUrl, close: closeServer } = await listen(app));
});

// Runs even when tests or setup fail, so the per-run database never lingers.
after(async () => {
  try {
    await closeServer();
    await db.$client.end();
    await pg.end();
  } finally {
    try {
      await admin`DROP DATABASE IF EXISTS ${admin(dbName)} WITH (FORCE)`;
    } finally {
      await admin.end();
    }
  }
});

afterEach(async () => {
  for (const handle of [...held]) await handle.rollback();
});

beforeEach(async () => {
  // Safe: this file's own database on the disposable server (guarded above).
  await pg`TRUNCATE candidate_skill_evidence, candidate_evidence_source, candidate_skill RESTART IDENTITY`;
  await pg`DELETE FROM candidate_profile`;
});

describe("POST /evidence", () => {
  it("creates a source from type and title alone, unreviewed, manual and unlinked", async () => {
    const source = await created({ type: "cv", title: "CV 2026" });
    assert.deepEqual(Object.keys(source).sort(), RESPONSE_KEYS);
    assert.equal(typeof source.id, "number");
    assert.deepEqual(
      { ...source, id: 0, createdAt: "", updatedAt: "" },
      { id: 0, type: "cv", title: "CV 2026", description: null, url: null, origin: "manual", reviewedAt: null, skillIds: [], createdAt: "", updatedAt: "" }
    );
    assert.match(source.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(source.updatedAt, source.createdAt);
    assert.deepEqual(await get(source.id), { status: 200, text: JSON.stringify(source), json: source });
  });

  it("stores every field, normalized, and accepts explicit nulls", async () => {
    const source = await created({ ...fullSource, title: "  Job \t Flow ", url: "HTTPS://Example.COM/project" });
    assert.equal(source.title, "Job Flow");
    assert.equal(source.description, fullSource.description);
    assert.equal(source.url, "https://example.com/project");
    const empty = await created({ type: "other", title: "X", description: null, url: "" });
    assert.equal(empty.description, null);
    assert.equal(empty.url, null);
  });

  it("accepts every source type", async () => {
    for (const type of ["professional_experience", "personal_project", "cv", "portfolio", "other"]) {
      assert.equal((await created({ type, title: type })).type, type);
    }
  });

  it("rejects skillIds, origin, review and verification fields without creating anything", async () => {
    for (const extra of [{ skillIds: [] }, { origin: "manual" }, { reviewedAt: null }, { id: 1 }, { verified: true }]) {
      const res = await post({ ...fullSource, ...extra });
      assert.equal(res.status, 400);
      assert.equal(res.json.error, "validation_error");
      assert.equal(res.json.message, "The evidence is invalid.");
      assert.deepEqual(res.json.details.map((d: { field: string }) => d.field), Object.keys(extra));
    }
    assert.deepEqual((await list()).json, []);
  });
});

describe("GET /evidence", () => {
  it("returns 200 with an empty array when there are no sources", async () => {
    const res = await list();
    assert.equal(res.status, 200);
    assert.equal(res.text, "[]");
  });

  it("orders by createdAt descending, then id descending, with each source's skills", async () => {
    const a = await created({ type: "other", title: "A" });
    const b = await created({ type: "other", title: "B" });
    const c = await created({ type: "other", title: "C" });
    const d = await created({ type: "other", title: "D" });
    await pg`UPDATE candidate_evidence_source SET created_at = '2026-01-01T00:00:00Z' WHERE id IN (${a.id}, ${c.id})`;
    await pg`UPDATE candidate_evidence_source SET created_at = '2026-06-01T00:00:00Z' WHERE id = ${b.id}`;
    await pg`UPDATE candidate_evidence_source SET created_at = '2025-01-01T00:00:00Z' WHERE id = ${d.id}`;
    const go = await skill("Go");
    const rust = await skill("Rust");
    await ok(putSkills(c.id, [rust, go]));
    await ok(putSkills(b.id, [go]));

    const res = await list();
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.json.map((s: { title: string; skillIds: number[] }) => [s.title, s.skillIds]),
      [["B", [go]], ["C", [go, rust]], ["A", []], ["D", []]]
    );
    for (const source of res.json) assert.deepEqual(source, (await get(source.id)).json);
  });
});

describe("GET /evidence/:id", () => {
  it("returns 404 for a well-formed id with no source", async () => {
    assert.deepEqual(await get(999), { status: 404, text: JSON.stringify(NOT_FOUND_BODY), json: NOT_FOUND_BODY });
  });
});

describe("PUT /evidence/:id", () => {
  it("replaces the content, keeps id, createdAt and skills, and advances updatedAt", async () => {
    const source = await created();
    const go = await skill("Go");
    await ok(putSkills(source.id, [go]));
    const replacement = { type: "portfolio", title: "Portfolio", description: null, url: null };
    const saved = await ok(put(source.id, replacement));
    assert.deepEqual(
      { ...saved, updatedAt: "" },
      { ...source, ...replacement, skillIds: [go], updatedAt: "" }
    );
    assert.ok(saved.updatedAt > source.updatedAt);
    assert.deepEqual((await get(source.id)).json, saved);
  });

  it("requires all four fields and rejects origin, timestamps, review and skills", async () => {
    const source = await created();
    for (const [body, expected] of [
      [{ type: "cv", title: "CV" }, ["description", "url"]],
      [{ ...fullSource, origin: "manual" }, ["origin"]],
      [{ ...fullSource, reviewedAt: null, updatedAt: source.updatedAt, createdAt: source.createdAt }, ["createdAt", "reviewedAt", "updatedAt"]],
      [{ ...fullSource, skillIds: [] }, ["skillIds"]],
    ] as const) {
      const res = await put(source.id, body);
      assert.equal(res.status, 400);
      assert.equal(res.json.error, "validation_error");
      assert.deepEqual(res.json.details.map((d: { field: string }) => d.field).sort(), [...expected].sort());
    }
    assert.deepEqual((await get(source.id)).json, source);
  });

  it("returns 404 for a well-formed id with no source", async () => {
    assert.deepEqual((await put(999, fullSource)).json, NOT_FOUND_BODY);
  });
});

describe("DELETE /evidence/:id", () => {
  it("deletes the source and its links, leaving the skills, and returns 204", async () => {
    const source = await created();
    const other = await created({ type: "cv", title: "CV" });
    const go = await skill("Go");
    const rust = await skill("Rust");
    await ok(putSkills(source.id, [go, rust]));
    await ok(putSkills(other.id, [go]));

    const res = await fetch(`${baseUrl}/evidence/${source.id}`, { method: "DELETE" });
    assert.equal(res.status, 204);
    assert.equal(await res.text(), "");
    assert.deepEqual(await links(), [[go, other.id]]);
    assert.equal((await request("GET", "/skills")).json.length, 2);
    assert.deepEqual((await del(source.id)).json, NOT_FOUND_BODY);
    assert.deepEqual((await get(source.id)).json, NOT_FOUND_BODY);
  });

  it("deleting a skill removes it from skillIds without touching the source's review", async () => {
    const source = await created();
    const go = await skill("Go");
    const rust = await skill("Rust");
    await ok(putSkills(source.id, [go, rust]));
    const reviewed = await ok(review(source.id, source.updatedAt));
    assert.equal((await request("DELETE", `/skills/${go}`)).status, 204);
    assert.deepEqual((await get(source.id)).json, { ...reviewed, skillIds: [rust] });
  });
});

describe("review lifecycle", () => {
  it("review sets reviewedAt and keeps updatedAt and the content", async () => {
    const source = await created();
    const reviewed = await ok(review(source.id, source.updatedAt));
    assert.deepEqual({ ...reviewed, reviewedAt: null }, source);
    assert.ok(Date.parse(reviewed.reviewedAt) >= Date.parse(source.createdAt));
    assert.deepEqual((await get(source.id)).json, reviewed);
  });

  it("a repeated review refreshes reviewedAt without changing updatedAt", async () => {
    const source = await created();
    await ok(review(source.id, source.updatedAt));
    await pg`UPDATE candidate_evidence_source SET reviewed_at = '2026-01-01T00:00:00Z' WHERE id = ${source.id}`;
    const again = await ok(review(source.id, source.updatedAt));
    assert.ok(Date.parse(again.reviewedAt) > Date.parse("2026-01-01T00:00:00Z"));
    assert.equal(again.updatedAt, source.updatedAt);
  });

  it("a successful review can leave reviewedAt later than an unchanged updatedAt", async () => {
    const source = await created();
    // Pin the content version to a fixed past instant, so the review's now() is
    // later without relying on how much time passes during the test.
    const version = "2000-01-01T00:00:00.000Z";
    await pg`UPDATE candidate_evidence_source SET updated_at = ${version}::timestamptz WHERE id = ${source.id}`;
    const reviewed = await ok(review(source.id, version));
    assert.equal(reviewed.updatedAt, version);
    assert.notEqual(reviewed.reviewedAt, null);
    assert.ok(Date.parse(reviewed.reviewedAt) > Date.parse(reviewed.updatedAt));
    const [row] = await pg`
      SELECT updated_at = ${version}::timestamptz AS unchanged, reviewed_at > updated_at AS later
      FROM candidate_evidence_source WHERE id = ${source.id}`;
    assert.deepEqual({ ...row }, { unchanged: true, later: true });
    assert.deepEqual((await get(source.id)).json, reviewed);
  });

  it("a material edit clears the review and makes the old version stale", async () => {
    const source = await created();
    await ok(review(source.id, source.updatedAt));
    const edited = await ok(put(source.id, { ...fullSource, description: "Changed." }));
    assert.equal(edited.reviewedAt, null);
    assert.ok(edited.updatedAt > source.updatedAt);

    const stale = await review(source.id, source.updatedAt);
    assert.equal(stale.status, 409);
    assert.deepEqual(stale.json, STALE_BODY);
    assert.equal((await get(source.id)).json.reviewedAt, null);
    assert.notEqual((await ok(review(source.id, edited.updatedAt))).reviewedAt, null);
  });

  it("each field counts as content, including clearing it to null", async () => {
    const source = await created();
    for (const patch of [{ type: "cv" }, { title: "Other" }, { description: null }, { url: null }, { url: "https://example.com/other" }]) {
      const current = (await get(source.id)).json;
      await ok(review(source.id, current.updatedAt));
      const saved = await ok(put(source.id, { type: current.type, title: current.title, description: current.description, url: current.url, ...patch }));
      assert.equal(saved.reviewedAt, null, JSON.stringify(patch));
      assert.ok(saved.updatedAt > current.updatedAt, JSON.stringify(patch));
    }
  });

  it("a no-op PUT, including one equal only after normalization, keeps updatedAt and the review", async () => {
    const source = await created();
    const reviewed = await ok(review(source.id, source.updatedAt));
    for (const body of [
      fullSource,
      { ...fullSource, title: "  JobFlow  ", url: "HTTPS://EXAMPLE.COM/project", description: `\r\n${fullSource.description}  ` },
    ]) {
      assert.deepEqual(await ok(put(source.id, body)), reviewed);
    }
    assert.deepEqual((await get(source.id)).json, reviewed);
  });

  it("changing skill links keeps reviewedAt and updatedAt", async () => {
    const source = await created();
    const go = await skill("Go");
    const reviewed = await ok(review(source.id, source.updatedAt));
    for (const skillIds of [[go], [], [go]]) {
      assert.deepEqual(await ok(putSkills(source.id, skillIds)), { ...reviewed, skillIds });
    }
  });

  it("returns 404 for an unknown source and 400 for a bad body or id", async () => {
    const source = await created();
    assert.deepEqual((await review(999, source.updatedAt)).json, NOT_FOUND_BODY);
    assert.deepEqual((await review("abc", source.updatedAt)).json, INVALID_ID_BODY);
    for (const res of [
      await review(source.id, "2026-10-29T12:00:00Z"),
      await review(source.id, null),
      await request("POST", `/evidence/${source.id}/review`, {}),
      await request("POST", `/evidence/${source.id}/review`, { expectedUpdatedAt: source.updatedAt, verified: true }),
      await request("POST", `/evidence/${source.id}/review`),
    ]) {
      assert.equal(res.status, 400);
      assert.equal(res.json.error, "validation_error");
      assert.equal(res.json.message, "The review request is invalid.");
    }
    assert.equal((await get(source.id)).json.reviewedAt, null);
  });
});

describe("content version precision", () => {
  it("compares at the millisecond precision the API serializes", async () => {
    const source = await created();
    // A sub-millisecond value, as a direct write with the column default would store.
    await pg`UPDATE candidate_evidence_source SET updated_at = '2026-01-01T00:00:00.123456Z' WHERE id = ${source.id}`;
    const current = (await get(source.id)).json;
    assert.equal(current.updatedAt, "2026-01-01T00:00:00.123Z");
    assert.equal((await review(source.id, "2026-01-01T00:00:00.124Z")).status, 409);
    assert.equal((await review(source.id, "2026-01-01T00:00:00.122Z")).status, 409);
    await ok(review(source.id, "2026-01-01T00:00:00.123Z"));
  });

  it("stores whole milliseconds, so the public value is the stored value", async () => {
    const source = await created();
    await ok(put(source.id, { ...fullSource, title: "Edited" }));
    const [row] = await pg`
      SELECT created_at = date_trunc('milliseconds', created_at) AS c, updated_at = date_trunc('milliseconds', updated_at) AS u
      FROM candidate_evidence_source WHERE id = ${source.id}`;
    assert.deepEqual({ ...row }, { c: true, u: true });
  });

  it("gives every content version a distinct updatedAt, even within one millisecond or with the clock behind", async () => {
    const source = await created();
    // Put the stored version an hour ahead of the clock: every following edit
    // happens "within" or "before" that millisecond as far as now() can tell.
    await pg`UPDATE candidate_evidence_source SET updated_at = date_trunc('milliseconds', now()) + interval '1 hour' WHERE id = ${source.id}`;
    const start = (await get(source.id)).json.updatedAt;
    const versions = [start];
    for (let i = 1; i <= 5; i++) {
      versions.push((await ok(put(source.id, { ...fullSource, title: `Edit ${i}` }))).updatedAt);
    }
    assert.deepEqual(
      versions.map((v) => Date.parse(v) - Date.parse(start)),
      [0, 1, 2, 3, 4, 5]
    );
    // Only the latest version can be reviewed.
    for (const old of versions.slice(0, -1)) assert.equal((await review(source.id, old)).status, 409, old);
    await ok(review(source.id, versions.at(-1)));
  });

  it("rapid consecutive edits always advance updatedAt", async () => {
    const source = await created();
    let previous = source.updatedAt;
    for (let i = 0; i < 20; i++) {
      const saved = await ok(put(source.id, { ...fullSource, title: `Rapid ${i}` }));
      assert.ok(saved.updatedAt > previous, `${saved.updatedAt} > ${previous}`);
      assert.equal((await review(source.id, previous)).status, 409);
      previous = saved.updatedAt;
    }
  });
});

describe("concurrent review and edit", () => {
  it("a review queued behind an edit of the version it saw is rejected as stale", async () => {
    const source = await created();
    const lock = await hold((t) => t`SELECT 1 FROM candidate_evidence_source WHERE id = ${source.id} FOR UPDATE`);
    const edit = put(source.id, { ...fullSource, title: "Edited elsewhere" });
    await lockWaiters(1);
    const late = review(source.id, source.updatedAt);
    await lockWaiters(2);
    await lock.commit();
    const [editRes, reviewRes] = await Promise.all([edit, late]);

    assert.equal(editRes.status, 200);
    // PostgreSQL does not promise which waiter gets the row first; both orders
    // must end unreviewed with the new content.
    if (reviewRes.status === 200) assert.equal(reviewRes.json.updatedAt, source.updatedAt);
    else assert.deepEqual(reviewRes.json, STALE_BODY);
    const final = (await get(source.id)).json;
    assert.equal(final.title, "Edited elsewhere");
    assert.equal(final.reviewedAt, null);
    assert.equal(final.updatedAt, editRes.json.updatedAt);
  });
});

describe("PUT /evidence/:id/skills", () => {
  it("links, replaces and unlinks the complete set, returning sorted skillIds", async () => {
    const source = await created();
    const [a, b, c] = [await skill("A"), await skill("B"), await skill("C")];
    assert.deepEqual((await ok(putSkills(source.id, [c, a]))).skillIds, [a, c]);
    assert.deepEqual((await ok(putSkills(source.id, [b, c]))).skillIds, [b, c]);
    assert.deepEqual((await ok(putSkills(source.id, [c, b]))).skillIds, [b, c]);
    assert.deepEqual(await links(), [[b, source.id], [c, source.id]]);
    assert.deepEqual((await ok(putSkills(source.id, []))).skillIds, []);
    assert.deepEqual(await links(), []);
    assert.equal((await request("GET", "/skills")).json.length, 3);
  });

  it("keeps other sources' links", async () => {
    const [x, y] = [await created(), await created({ type: "cv", title: "CV" })];
    const [a, b] = [await skill("A"), await skill("B")];
    await ok(putSkills(x.id, [a, b]));
    await ok(putSkills(y.id, [a]));
    await ok(putSkills(x.id, []));
    assert.deepEqual(await links(), [[a, y.id]]);
  });

  it("rejects duplicates and malformed ids without changing the links", async () => {
    const source = await created();
    const a = await skill("A");
    await ok(putSkills(source.id, [a]));
    for (const [skillIds, expected] of [
      [[a, a], ["skillIds[1]"]],
      [[String(a)], ["skillIds[0]"]],
      [[1.5, 0, -2], ["skillIds[0]", "skillIds[1]", "skillIds[2]"]],
      [null, ["skillIds"]],
      [Array.from({ length: 501 }, (_, i) => i + 1), ["skillIds"]],
    ] as const) {
      const res = await putSkills(source.id, skillIds);
      assert.equal(res.status, 400);
      assert.equal(res.json.error, "validation_error");
      assert.equal(res.json.message, "The skill links are invalid.");
      assert.deepEqual(res.json.details.map((d: { field: string }) => d.field), expected);
    }
    assert.deepEqual(await links(), [[a, source.id]]);
  });

  it("rejects ids of skills that do not exist, naming each, without changing the links", async () => {
    const source = await created();
    const [a, b] = [await skill("A"), await skill("B")];
    await ok(putSkills(source.id, [a]));
    const res = await putSkills(source.id, [b, 999, a, 1000]);
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, {
      error: "validation_error",
      message: "The skill links are invalid.",
      details: [
        { field: "skillIds[1]", message: "does not refer to an existing skill" },
        { field: "skillIds[3]", message: "does not refer to an existing skill" },
      ],
    });
    assert.deepEqual(await links(), [[a, source.id]]);
  });

  it("accepts 500 ids", async () => {
    const source = await created();
    await pg`INSERT INTO candidate_skill (name) SELECT 'Skill ' || i FROM generate_series(1, 500) AS i`;
    const ids = (await pg`SELECT id FROM candidate_skill ORDER BY id DESC`).map((r) => r.id as number);
    assert.equal((await ok(putSkills(source.id, ids))).skillIds.length, 500);
  });

  it("returns 404 for an unknown source, after validating the body", async () => {
    assert.deepEqual((await putSkills(999, [])).json, NOT_FOUND_BODY);
    assert.equal((await putSkills(999, ["1"])).status, 400);
    assert.deepEqual((await putSkills("01", [])).json, INVALID_ID_BODY);
  });

  it("rolls back the whole replacement when a write fails part-way", async () => {
    const source = await created();
    const [a, b, c, poison] = [await skill("A"), await skill("B"), await skill("C"), await skill("Poison")];
    await ok(putSkills(source.id, [a, b]));
    // Test-only failure injection, in this file's own database: inserting a
    // link to `poison` fails after the obsolete links were already deleted.
    await pg.unsafe(`
      CREATE FUNCTION fail_poison_link() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN IF NEW.skill_id = ${poison} THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_poison_link BEFORE INSERT ON candidate_skill_evidence
        FOR EACH ROW EXECUTE FUNCTION fail_poison_link();`);
    const log = captureConsoleError();
    try {
      const res = await putSkills(source.id, [c, poison]);
      assert.equal(res.status, 500);
      assert.deepEqual(res.json, { error: "internal_error", message: "An unexpected error occurred." });
      assertNoSensitiveContent(res.text, ["injected", "P0001", "candidate_skill_evidence"]);
      assert.deepEqual(log.lines, [`PUT /evidence/${source.id}/skills failed: database_error [P0001]`]);
    } finally {
      log.restore();
      await pg.unsafe(`DROP TRIGGER fail_poison_link ON candidate_skill_evidence; DROP FUNCTION fail_poison_link();`);
    }
    assert.deepEqual(await links(), [[a, source.id], [b, source.id]]);
  });

  it("serializes concurrent replacements of the same source: the result is one set, never a mix", async () => {
    const source = await created();
    const [a, b, c, d] = [await skill("A"), await skill("B"), await skill("C"), await skill("D")];
    await ok(putSkills(source.id, [a]));
    const lock = await hold((t) => t`SELECT 1 FROM candidate_evidence_source WHERE id = ${source.id} FOR UPDATE`);
    const first = putSkills(source.id, [a, b]);
    const second = putSkills(source.id, [c, d]);
    await lockWaiters(2);
    await lock.commit();
    const results = await Promise.all([first, second]);
    for (const res of results) assert.equal(res.status, 200);

    const final = (await get(source.id)).json.skillIds;
    assert.ok(
      JSON.stringify(final) === JSON.stringify([a, b]) || JSON.stringify(final) === JSON.stringify([c, d]),
      `unexpected final set ${JSON.stringify(final)}`
    );
    // Each response is the set as its own transaction committed it.
    assert.deepEqual(results.map((r) => r.json.skillIds).sort(), [[a, b], [c, d]].sort());
  });

  it("a skill deleted by a transaction that commits first is reported missing", async () => {
    const source = await created();
    const [a, b] = [await skill("A"), await skill("B")];
    const deletion = await hold((t) => t`DELETE FROM candidate_skill WHERE id = ${b}`);
    const res = putSkills(source.id, [a, b]);
    await lockWaiters(1);
    await deletion.commit();
    const r = await res;
    assert.equal(r.status, 400);
    assert.deepEqual(r.json.details, [{ field: "skillIds[1]", message: "does not refer to an existing skill" }]);
    assert.deepEqual(await links(), []);
  });

  it("a skill deletion that rolls back lets the replacement succeed", async () => {
    const source = await created();
    const [a, b] = [await skill("A"), await skill("B")];
    const deletion = await hold((t) => t`DELETE FROM candidate_skill WHERE id = ${b}`);
    const res = putSkills(source.id, [a, b]);
    await lockWaiters(1);
    await deletion.rollback();
    assert.deepEqual((await ok(res)).skillIds, [a, b]);
  });

  it("a skill deleted after the replacement locked it waits, then cascades the new link away", async () => {
    const source = await created();
    const [a, b] = [await skill("A"), await skill("B")];
    // Block the replacement after it has locked the source, on skill b.
    const blocker = await hold((t) => t`SELECT 1 FROM candidate_skill WHERE id = ${b} FOR UPDATE`);
    const res = putSkills(source.id, [a, b]);
    await lockWaiters(1);
    await blocker.commit();
    assert.deepEqual((await ok(res)).skillIds, [a, b]);
    assert.equal((await request("DELETE", `/skills/${b}`)).status, 204);
    assert.deepEqual((await get(source.id)).json.skillIds, [a]);
  });

  it("a source deleted by a transaction that commits first makes the replacement 404", async () => {
    const source = await created();
    const a = await skill("A");
    const deletion = await hold((t) => t`DELETE FROM candidate_evidence_source WHERE id = ${source.id}`);
    const res = putSkills(source.id, [a]);
    await lockWaiters(1);
    await deletion.commit();
    assert.deepEqual((await res).json, NOT_FOUND_BODY);
    assert.deepEqual(await links(), []);
  });

  it("a source DELETE queued behind a replacement waits for it, then removes its links", async () => {
    const source = await created();
    const [a, b] = [await skill("A"), await skill("B")];
    // The replacement locks the source, then waits on skill b.
    const blocker = await hold((t) => t`SELECT 1 FROM candidate_skill WHERE id = ${b} FOR UPDATE`);
    const replacement = putSkills(source.id, [a, b]);
    await lockWaiters(1);
    const deletion = del(source.id);
    await lockWaiters(2);
    await blocker.commit();
    assert.deepEqual((await ok(replacement)).skillIds, [a, b]);
    assert.equal((await deletion).status, 204);
    assert.deepEqual(await links(), []);
    assert.equal((await request("GET", "/skills")).json.length, 2);
  });
});

describe("invalid ids (400)", () => {
  const invalidIds = ["0", "00", "01", "-1", "+1", "1.0", "1e3", "0x1", "%201", "abc", "2147483648", "1".repeat(300)];

  it("every :id route rejects non-canonical or out-of-range ids before validating the body", async () => {
    const source = await created();
    for (const id of invalidIds) {
      for (const res of [
        await get(id),
        await put(id, { bogus: true }),
        await del(id),
        await putSkills(id, "bogus"),
        await review(id, "bogus"),
      ]) {
        assert.equal(res.status, 400, id);
        assert.deepEqual(res.json, INVALID_ID_BODY);
      }
    }
    assert.deepEqual((await list()).json, [source]);
  });
});

describe("request body errors", () => {
  it("rejects malformed JSON with a safe message", async () => {
    const source = await created();
    for (const [method, path] of [
      ["POST", "/evidence"],
      ["PUT", `/evidence/${source.id}`],
      ["PUT", `/evidence/${source.id}/skills`],
      ["POST", `/evidence/${source.id}/review`],
    ]) {
      const res = await request(method, path, undefined, '{"title": "x",');
      assert.equal(res.status, 400);
      assert.deepEqual(res.json, { error: "invalid_json", message: "Request body must be a valid JSON object." });
    }
  });

  it("rejects non-object and non-JSON bodies", async () => {
    const source = await created();
    assert.deepEqual((await post([fullSource])).json.details, [{ field: "body", message: "must be a JSON object" }]);
    assert.deepEqual((await request("PUT", `/evidence/${source.id}/skills`, [1])).json.details, [{ field: "body", message: "must be a JSON object" }]);
    const res = await fetch(`${baseUrl}/evidence`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(fullSource) });
    assert.equal(res.status, 400);
    assert.deepEqual((await list()).json, [source]);
  });

  it("rejects a body over the 128 kB limit with 413", async () => {
    const source = await created();
    const huge = JSON.stringify({ ...fullSource, description: "x".repeat(200_000) });
    for (const res of [
      await request("POST", "/evidence", undefined, huge),
      await request("PUT", `/evidence/${source.id}`, undefined, huge),
      await request("PUT", `/evidence/${source.id}/skills`, undefined, JSON.stringify({ skillIds: Array(70_000).fill(1) })),
    ]) {
      assert.equal(res.status, 413);
      assert.deepEqual(res.json, { error: "payload_too_large", message: "Request body is too large." });
    }
    assert.deepEqual((await list()).json, [source]);
  });
});

describe("database errors", () => {
  it("returns a generic 500 for an unexpected database error, without leaking or logging evidence content", async () => {
    const source = await created();
    // Every evidence response reads the link table; hide it to simulate an
    // unexpected (non-connectivity) failure. Restored afterwards.
    await pg`ALTER TABLE candidate_skill_evidence RENAME TO candidate_skill_evidence_hidden`;
    const log = captureConsoleError();
    const secret = "UNIQUE-EVIDENCE-MARKER-5b2c";
    const secretSource = { ...fullSource, title: secret, description: secret, url: `https://${secret.toLowerCase()}.example/` };
    try {
      const responses = [
        await list(),
        await get(source.id),
        await post(secretSource),
        await put(source.id, secretSource),
        await putSkills(source.id, []),
        await review(source.id, source.updatedAt),
      ];
      for (const res of responses) {
        assert.equal(res.status, 500);
        assert.deepEqual(res.json, { error: "internal_error", message: "An unexpected error occurred." });
        assertNoSensitiveContent(res.text, [secret, "42P01", "relation", "candidate_skill_evidence", "example"]);
      }
      assert.deepEqual(log.lines, [
        "GET /evidence failed: database_error [42P01]",
        `GET /evidence/${source.id} failed: database_error [42P01]`,
        "POST /evidence failed: database_error [42P01]",
        `PUT /evidence/${source.id} failed: database_error [42P01]`,
        `PUT /evidence/${source.id}/skills failed: database_error [42P01]`,
        `POST /evidence/${source.id}/review failed: database_error [42P01]`,
      ]);
      for (const line of log.lines) {
        for (const marker of [secret, secret.toLowerCase(), "relation", "candidate_", "JobFlow", "example"]) {
          assert.ok(!line.includes(marker), `log leaked ${JSON.stringify(marker)}`);
        }
      }
    } finally {
      log.restore();
      await pg`ALTER TABLE candidate_skill_evidence_hidden RENAME TO candidate_skill_evidence`;
    }
    // The failed writes were not applied.
    assert.deepEqual((await list()).json, [source]);
  });
});

describe("profile and skills are unaffected", () => {
  it("evidence operations leave the profile and skills as saved, with unchanged response shapes", async () => {
    const profile = {
      headline: "Backend Engineer",
      experienceSummary: null,
      location: null,
      targetRoles: ["Backend Engineer"],
      workModel: "remote",
      careerInstructions: null,
    };
    const savedProfile = await ok(request("PUT", "/profile", profile));
    const go = await skill("Go");
    const skillsBefore = (await request("GET", "/skills")).json;
    assert.deepEqual(Object.keys(skillsBefore[0]).sort(), [
      "createdAt",
      "experienceContexts",
      "experienceMonths",
      "id",
      "interviewConfidence",
      "lastUsedYear",
      "name",
      "notes",
      "practicalConfidence",
      "updatedAt",
    ]);

    const source = await created();
    await ok(putSkills(source.id, [go]));
    await ok(review(source.id, source.updatedAt));
    await ok(put(source.id, { ...fullSource, title: "Edited" }));
    await ok(putSkills(source.id, []));
    assert.equal((await del(source.id)).status, 204);

    assert.deepEqual((await request("GET", "/skills")).json, skillsBefore);
    assert.deepEqual((await request("GET", "/profile")).json, savedProfile);
  });
});
