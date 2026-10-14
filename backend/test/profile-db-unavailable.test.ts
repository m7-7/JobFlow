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

describe("database unavailable", () => {
  it("GET /profile returns a safe 503", async () => {
    const res = await fetch(`${baseUrl}/profile`);
    const text = await res.text();
    assert.equal(res.status, 503);
    assert.deepEqual(JSON.parse(text), {
      error: "database_unavailable",
      message: "The database is currently unavailable. Please try again later.",
    });
    assertNoSensitiveContent(text, leakMarkers);
  });

  it("PUT /profile with a valid body returns a safe 503 and does not log the payload", async () => {
    const marker = "UNIQUE-PAYLOAD-MARKER-b81c";
    const res = await fetch(`${baseUrl}/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        headline: marker,
        experienceSummary: null,
        location: null,
        targetRoles: [],
        workModel: null,
        careerInstructions: null,
      }),
    });
    const text = await res.text();
    assert.equal(res.status, 503);
    assert.equal(JSON.parse(text).error, "database_unavailable");
    assertNoSensitiveContent(text, [...leakMarkers, marker]);
    assert.ok(log.lines.some((l) => l.endsWith("failed: database_unavailable [ECONNREFUSED]")), "code is logged server-side");
    assert.ok(log.lines.every((l) => !l.includes("127.0.0.1") && !l.includes("leakcheck_user")), "no host or username logged");
    assert.ok(log.lines.every((l) => !l.includes(marker) && !l.includes("leakcheck_secret")));
  });

  it("validation still returns 400 without touching the database", async () => {
    const res = await fetch(`${baseUrl}/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 400);
  });

  it("GET /health keeps its existing 503 response and logs no driver details", async () => {
    const before = log.lines.length;
    const res = await fetch(`${baseUrl}/health`);
    const text = await res.text();
    assert.equal(res.status, 503);
    assert.deepEqual(JSON.parse(text), { status: "error", db: "unreachable" });
    assertNoSensitiveContent(text, leakMarkers);

    // The raw driver message here is "connect ECONNREFUSED 127.0.0.1:1".
    const healthLogs = log.lines.slice(before);
    assert.deepEqual(healthLogs, ["Health check failed: database_unavailable [ECONNREFUSED]"]);
    for (const marker of [...leakMarkers, "127.0.0.1", "connect ", "    at "]) {
      assert.ok(!healthLogs.join("\n").includes(marker), `health log leaked ${JSON.stringify(marker)}`);
    }
  });
});
