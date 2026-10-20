import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { DrizzleQueryError } from "drizzle-orm";
import { errorHandler, isUniqueViolation } from "../src/errors.js";
import { captureConsoleError } from "./helpers.js";

// Unit tests for the error handler's logging and response safety, using real
// DrizzleQueryError wrappers whose messages carry SQL and profile values.

const SECRET = "SENSITIVE-MARKER-c4d2";
const SQL_TEXT = `insert into "candidate_profile" ("headline") values ($1)`;

function run(err: unknown) {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
  } as unknown as Response;
  const req = { method: "PUT", path: "/profile" } as Request;

  const log = captureConsoleError();
  try {
    errorHandler(err, req, res, (() => {}) as NextFunction);
  } finally {
    log.restore();
  }
  return { ...sent, logs: log.lines, all: JSON.stringify(sent.body) + "\n" + log.lines.join("\n") };
}

function assertNoLeak(all: string) {
  for (const marker of [SECRET, "Failed query", "insert into", "params", "candidate_profile", "    at "]) {
    assert.ok(!all.includes(marker), `leaked ${JSON.stringify(marker)}`);
  }
}

function driverError(message: string, code: unknown) {
  return Object.assign(new Error(message), { code, detail: `Failing row contains (${SECRET})` });
}

describe("errorHandler logging safety", () => {
  it("never logs a Drizzle wrapper whose cause is not an Error", () => {
    for (const cause of [undefined, null, `cause ${SECRET}`, { code: "23514", message: SECRET }]) {
      const err = new DrizzleQueryError(SQL_TEXT, [SECRET], cause as unknown as Error);
      const out = run(err);
      assert.equal(out.status, 500);
      assert.deepEqual(out.body, { error: "internal_error", message: "An unexpected error occurred." });
      // DrizzleQueryError does not set its own `name`, so it logs as "Error".
      assert.deepEqual(out.logs, ["PUT /profile failed: unexpected_error [Error]"]);
      assertNoLeak(out.all);
    }
  });

  it("logs only category and SQLSTATE for a wrapped SQL error, not the driver message", () => {
    const cause = driverError(`invalid input syntax for type json: "${SECRET}"`, "22P02");
    const out = run(new DrizzleQueryError(SQL_TEXT, [SECRET], cause));
    assert.equal(out.status, 500);
    assert.deepEqual(out.logs, ["PUT /profile failed: database_error [22P02]"]);
    assertNoLeak(out.all);
  });

  it("logs only category and code for connection failures, not hosts or credentials", () => {
    const cause = driverError(`connect ECONNREFUSED 10.0.0.5:5432 user ${SECRET}`, "ECONNREFUSED");
    const out = run(new DrizzleQueryError(SQL_TEXT, [SECRET], cause));
    assert.equal(out.status, 503);
    assert.deepEqual(out.logs, ["PUT /profile failed: database_unavailable [ECONNREFUSED]"]);
    assert.ok(!out.all.includes("10.0.0.5"));
    assertNoLeak(out.all);
  });

  it("treats an unavailable SQLSTATE as 503", () => {
    const out = run(new DrizzleQueryError(SQL_TEXT, [SECRET], driverError(SECRET, "57P03")));
    assert.equal(out.status, 503);
    assert.deepEqual(out.logs, ["PUT /profile failed: database_unavailable [57P03]"]);
    assertNoLeak(out.all);
  });

  it("does not log a malformed or unexpected code value", () => {
    for (const code of [`${SECRET}`, "22p02", "123456", 42, { x: SECRET }]) {
      const out = run(new DrizzleQueryError(SQL_TEXT, [SECRET], driverError(SECRET, code)));
      assert.equal(out.status, 500);
      assert.deepEqual(out.logs, ["PUT /profile failed: unexpected_error [Error]"]);
      assertNoLeak(out.all);
    }
  });

  it("logs only the error name for non-database errors", () => {
    const out = run(new TypeError(`Cannot read ${SECRET}`));
    assert.equal(out.status, 500);
    assert.deepEqual(out.logs, ["PUT /profile failed: unexpected_error [TypeError]"]);
    assertNoLeak(out.all);
  });

  it("does not log a non-Error thrown value", () => {
    const out = run(`thrown ${SECRET}`);
    assert.equal(out.status, 500);
    assert.deepEqual(out.logs, ["PUT /profile failed: unexpected_error [unknown]"]);
    assertNoLeak(out.all);
  });
});

describe("isUniqueViolation", () => {
  const INDEX = "candidate_skill_name_normalized_unique";
  const uniqueError = (constraint: unknown, code: unknown = "23505") =>
    Object.assign(new Error(`duplicate key value ${SECRET}`), { code, constraint_name: constraint });

  it("matches SQLSTATE 23505 on the named index, wrapped by Drizzle or not", () => {
    assert.equal(isUniqueViolation(uniqueError(INDEX), INDEX), true);
    assert.equal(isUniqueViolation(new DrizzleQueryError(SQL_TEXT, [SECRET], uniqueError(INDEX)), INDEX), true);
  });

  it("does not match a unique violation of another constraint", () => {
    for (const constraint of ["candidate_skill_pkey", "other_unique", undefined, null, `${INDEX}_x`]) {
      assert.equal(isUniqueViolation(new DrizzleQueryError(SQL_TEXT, [SECRET], uniqueError(constraint)), INDEX), false);
    }
  });

  it("does not match another SQLSTATE on the same index", () => {
    for (const code of ["23514", "23502", "40001", 23505, null]) {
      assert.equal(isUniqueViolation(new DrizzleQueryError(SQL_TEXT, [SECRET], uniqueError(INDEX, code)), INDEX), false);
    }
  });

  it("does not match non-driver values", () => {
    for (const err of [undefined, null, "23505", INDEX, new TypeError(INDEX)]) {
      assert.equal(isUniqueViolation(err, INDEX), false);
    }
  });

  it("an unrecognized 23505 still reaches the error handler as a safe 500", () => {
    const out = run(new DrizzleQueryError(SQL_TEXT, [SECRET], uniqueError("other_unique")));
    assert.equal(out.status, 500);
    assert.deepEqual(out.logs, ["PUT /profile failed: database_error [23505]"]);
    assertNoLeak(out.all);
  });
});
