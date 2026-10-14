import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LIMITS, validateProfileInput } from "../src/profile-validation.js";

const valid = {
  headline: "Senior Backend Engineer",
  experienceSummary: "Ten years of TypeScript.",
  location: "Athens, Greece",
  targetRoles: ["Backend Engineer", "Platform Engineer"],
  workModel: "remote",
  careerInstructions: "Prefer product companies.",
};

function errorsFor(body: unknown) {
  const result = validateProfileInput(body);
  assert.equal(result.ok, false);
  return result.ok ? [] : result.errors;
}

function fields(body: unknown) {
  return errorsFor(body).map((e) => e.field);
}

describe("validateProfileInput", () => {
  it("accepts a complete valid profile unchanged", () => {
    assert.deepEqual(validateProfileInput(valid), { ok: true, value: valid });
  });

  it("accepts a partial profile with null fields and empty target roles", () => {
    const body = {
      headline: null,
      experienceSummary: null,
      location: null,
      targetRoles: [],
      workModel: null,
      careerInstructions: null,
    };
    assert.deepEqual(validateProfileInput(body), { ok: true, value: body });
  });

  it("rejects non-object bodies", () => {
    for (const body of [undefined, null, "text", 42, true, [], [valid]]) {
      assert.deepEqual(fields(body), ["body"]);
    }
  });

  it("rejects missing keys, naming each one", () => {
    const { workModel: _w, targetRoles: _t, ...rest } = valid;
    assert.deepEqual(fields(rest).sort(), ["targetRoles", "workModel"]);
  });

  it("rejects unknown keys, including client-supplied id and timestamps", () => {
    assert.deepEqual(
      fields({ ...valid, id: 2, updatedAt: "2020-01-01T00:00:00Z", __proto__x: 1 }).sort(),
      ["__proto__x", "id", "updatedAt"]
    );
  });

  it("reports structural and value errors together in one response", () => {
    assert.deepEqual(errorsFor({ headline: 5, targetRoles: ["ok", ""], workModel: "office", id: 7 }), [
      { field: "id", message: "is not an allowed field" },
      { field: "experienceSummary", message: "is required (use null or [] for no value)" },
      { field: "location", message: "is required (use null or [] for no value)" },
      { field: "careerInstructions", message: "is required (use null or [] for no value)" },
      { field: "headline", message: "must be a string or null" },
      { field: "targetRoles[1]", message: "must not be empty" },
      { field: "workModel", message: "must be one of remote, hybrid, onsite, flexible, or null" },
    ]);
  });

  it("rejects a JSON __proto__ key as unknown", () => {
    const body = JSON.parse(JSON.stringify(valid).replace("{", '{"__proto__":{"admin":true},'));
    assert.deepEqual(fields(body), ["__proto__"]);
  });

  it("rejects non-string, non-null text fields", () => {
    const errs = errorsFor({ ...valid, headline: 5, location: {}, experienceSummary: ["x"], careerInstructions: false });
    assert.deepEqual(errs.map((e) => e.field).sort(), [
      "careerInstructions",
      "experienceSummary",
      "headline",
      "location",
    ]);
    assert.ok(errs.every((e) => e.message === "must be a string or null"));
  });

  it("trims text, collapses whitespace in single-line fields and keeps paragraphs", () => {
    const result = validateProfileInput({
      ...valid,
      headline: "  Senior \t Backend   Engineer \n",
      experienceSummary: "\r\n  First paragraph.\r\n\r\n  Second   paragraph.  ",
    });
    assert.ok(result.ok);
    assert.equal(result.value.headline, "Senior Backend Engineer");
    assert.equal(result.value.experienceSummary, "First paragraph.\n\n  Second   paragraph.");
  });

  it("normalizes whitespace-only text to null", () => {
    const result = validateProfileInput({ ...valid, headline: "", location: "   ", careerInstructions: "\n\t" });
    assert.ok(result.ok);
    assert.equal(result.value.headline, null);
    assert.equal(result.value.location, null);
    assert.equal(result.value.careerInstructions, null);
  });

  it("enforces maximum text lengths after trimming", () => {
    const atLimit = validateProfileInput({ ...valid, headline: ` ${"h".repeat(LIMITS.headline)} ` });
    assert.ok(atLimit.ok);

    const errs = errorsFor({
      ...valid,
      headline: "h".repeat(LIMITS.headline + 1),
      location: "l".repeat(LIMITS.location + 1),
      experienceSummary: "e".repeat(LIMITS.experienceSummary + 1),
      careerInstructions: "c".repeat(LIMITS.careerInstructions + 1),
    });
    assert.deepEqual(errs, [
      { field: "headline", message: "must be at most 200 characters" },
      { field: "experienceSummary", message: "must be at most 10000 characters" },
      { field: "location", message: "must be at most 200 characters" },
      { field: "careerInstructions", message: "must be at most 5000 characters" },
    ]);
  });

  it("counts length in characters, not UTF-16 units", () => {
    const result = validateProfileInput({ ...valid, headline: "😀".repeat(LIMITS.headline) });
    assert.ok(result.ok);
  });

  it("rejects control characters and invalid Unicode", () => {
    assert.deepEqual(errorsFor({ ...valid, headline: "a\u0000b" }), [
      { field: "headline", message: "must not contain control characters" },
    ]);
    assert.deepEqual(errorsFor({ ...valid, targetRoles: ["ok", "bad\u0007"] }), [
      { field: "targetRoles[1]", message: "must not contain control characters" },
    ]);
    assert.deepEqual(errorsFor({ ...valid, location: "x\uD800y" }), [
      { field: "location", message: "must be valid Unicode text" },
    ]);
  });

  it("rejects invalid work models", () => {
    for (const workModel of ["office", "REMOTE", "", 1, [], undefined]) {
      const errs = errorsFor({ ...valid, workModel });
      assert.equal(errs.length, 1);
      assert.equal(errs[0].field, "workModel");
    }
  });

  it("accepts every allowed work model", () => {
    for (const workModel of ["remote", "hybrid", "onsite", "flexible", null]) {
      assert.ok(validateProfileInput({ ...valid, workModel }).ok);
    }
  });

  it("rejects non-array target roles", () => {
    for (const targetRoles of [null, "Backend Engineer", { 0: "x" }, 3]) {
      assert.deepEqual(errorsFor({ ...valid, targetRoles }), [
        { field: "targetRoles", message: "must be an array of strings" },
      ]);
    }
  });

  it("rejects non-string and blank target role entries, by index", () => {
    assert.deepEqual(errorsFor({ ...valid, targetRoles: ["ok", 7, null, "   ", ["x"]] }), [
      { field: "targetRoles[1]", message: "must be a string" },
      { field: "targetRoles[2]", message: "must be a string" },
      { field: "targetRoles[3]", message: "must not be empty" },
      { field: "targetRoles[4]", message: "must be a string" },
    ]);
  });

  it("enforces the target role count and per-item length", () => {
    const tooMany = Array.from({ length: LIMITS.targetRolesCount + 1 }, (_, i) => `Role ${i}`);
    assert.deepEqual(errorsFor({ ...valid, targetRoles: tooMany }), [
      { field: "targetRoles", message: "must contain at most 20 roles" },
    ]);
    assert.deepEqual(errorsFor({ ...valid, targetRoles: ["r".repeat(LIMITS.targetRoleLength + 1)] }), [
      { field: "targetRoles[0]", message: "must be at most 100 characters" },
    ]);
  });

  it("normalizes target role whitespace and removes case-insensitive duplicates", () => {
    const result = validateProfileInput({
      ...valid,
      targetRoles: ["  Backend   Engineer ", "backend engineer", "Data Engineer", "BACKEND ENGINEER"],
    });
    assert.ok(result.ok);
    assert.deepEqual(result.value.targetRoles, ["Backend Engineer", "Data Engineer"]);
  });
});
