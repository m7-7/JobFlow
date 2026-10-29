import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertNoSensitiveContent, captureConsoleError, listen } from "./helpers.js";

// The database is unreachable: nothing listens on port 1. node:test runs each
// file in its own process, so this URL only affects this file. The
// credentials are fake and exist only to check they never leak.
process.env.DATABASE_URL = "postgresql://leakcheck_user:leakcheck_secret@127.0.0.1:1/unreachable_test";

const { app } = await import("../src/app.js");
const { db } = await import("../src/db.js");

let baseUrl = "";
let closeServer = async () => {};
const log = captureConsoleError();

before(async () => {
  ({ baseUrl, close: closeServer } = await listen(app));
});

after(async () => {
  log.restore();
  await closeServer();
  await db.$client.end({ timeout: 0 });
});

const leakMarkers = ["leakcheck_user", "leakcheck_secret", "unreachable_test", ":1/"];
const marker = "UNIQUE-EVIDENCE-MARKER-7a41";
const validSource = { type: "other", title: marker, description: marker, url: `https://${marker.toLowerCase()}.example/` };

async function request(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

describe("evidence API with the database unavailable", () => {
  it("every endpoint returns a safe 503 and logs no payload, host or credentials", async () => {
    const responses = [
      await request("GET", "/evidence"),
      await request("POST", "/evidence", validSource),
      await request("GET", "/evidence/1"),
      await request("PUT", "/evidence/1", validSource),
      await request("DELETE", "/evidence/1"),
      await request("PUT", "/evidence/1/skills", { skillIds: [1, 2] }),
      await request("POST", "/evidence/1/review", { expectedUpdatedAt: "2026-10-29T12:00:00.000Z" }),
    ];
    for (const res of responses) {
      assert.equal(res.status, 503);
      assert.deepEqual(res.json, {
        error: "database_unavailable",
        message: "The database is currently unavailable. Please try again later.",
      });
      assertNoSensitiveContent(res.text, [...leakMarkers, marker]);
    }
    assert.deepEqual(log.lines, [
      "GET /evidence failed: database_unavailable [ECONNREFUSED]",
      "POST /evidence failed: database_unavailable [ECONNREFUSED]",
      "GET /evidence/1 failed: database_unavailable [ECONNREFUSED]",
      "PUT /evidence/1 failed: database_unavailable [ECONNREFUSED]",
      "DELETE /evidence/1 failed: database_unavailable [ECONNREFUSED]",
      "PUT /evidence/1/skills failed: database_unavailable [ECONNREFUSED]",
      "POST /evidence/1/review failed: database_unavailable [ECONNREFUSED]",
    ]);
    for (const line of log.lines) {
      for (const leak of [...leakMarkers, marker, marker.toLowerCase(), "127.0.0.1"]) assert.ok(!line.includes(leak));
    }
  });

  it("validation and id errors still return 400 without touching the database", async () => {
    const before = log.lines.length;
    for (const res of [
      await request("POST", "/evidence", {}),
      await request("PUT", "/evidence/1", { type: "cv" }),
      await request("GET", "/evidence/abc"),
      await request("DELETE", "/evidence/0"),
      await request("PUT", "/evidence/1/skills", { skillIds: [1, 1] }),
      await request("POST", "/evidence/1/review", {}),
    ]) {
      assert.equal(res.status, 400);
    }
    assert.equal(log.lines.length, before);
  });
});
