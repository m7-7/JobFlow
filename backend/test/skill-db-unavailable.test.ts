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
const marker = "UNIQUE-SKILL-MARKER-3d07";
const validSkill = {
  name: marker,
  experienceContexts: [],
  practicalConfidence: null,
  interviewConfidence: null,
  experienceMonths: null,
  lastUsedYear: null,
  notes: marker,
};

async function request(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

describe("skills API with the database unavailable", () => {
  it("every endpoint returns a safe 503 and logs no payload, host or credentials", async () => {
    const responses = [
      await request("GET", "/skills"),
      await request("POST", "/skills", { name: marker, notes: marker }),
      await request("PUT", "/skills/1", validSkill),
      await request("DELETE", "/skills/1"),
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
      "GET /skills failed: database_unavailable [ECONNREFUSED]",
      "POST /skills failed: database_unavailable [ECONNREFUSED]",
      "PUT /skills/1 failed: database_unavailable [ECONNREFUSED]",
      "DELETE /skills/1 failed: database_unavailable [ECONNREFUSED]",
    ]);
    for (const line of log.lines) {
      for (const leak of [...leakMarkers, marker, "127.0.0.1"]) assert.ok(!line.includes(leak));
    }
  });

  it("validation and id errors still return 400 without touching the database", async () => {
    const before = log.lines.length;
    for (const res of [
      await request("POST", "/skills", {}),
      await request("PUT", "/skills/1", { name: "Go" }),
      await request("PUT", "/skills/abc", validSkill),
      await request("DELETE", "/skills/0"),
    ]) {
      assert.equal(res.status, 400);
    }
    assert.equal(log.lines.length, before);
  });
});
