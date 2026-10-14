// Dependency-free unit tests (node:test, Node's built-in TypeScript type
// stripping). Run with `npm test`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  characterCount,
  formatTargetRoles,
  formValuesEqual,
  groupFieldErrors,
  mergeSavedValues,
  parseProfileResponse,
  parseTargetRoles,
  toFormValues,
  toProfileInput,
  type FormValues,
} from "./profile.ts";

const profile = {
  headline: "Senior Backend Engineer",
  experienceSummary: "Ten years of TypeScript.\n\nLed a platform team.",
  location: "Athens, Greece",
  targetRoles: ["Backend Engineer", "Platform Engineer"],
  workModel: "hybrid" as const,
  careerInstructions: "Prefer product companies.",
  updatedAt: "2026-10-14T09:17:41.404Z",
};

const emptyForm: FormValues = {
  headline: "",
  experienceSummary: "",
  location: "",
  targetRoles: "",
  workModel: "",
  careerInstructions: "",
};

describe("target roles text <-> array", () => {
  it("splits on commas, trims, and drops blank entries", () => {
    assert.deepEqual(parseTargetRoles(" Backend Engineer ,Platform Engineer,, ,Data  Engineer, "), [
      "Backend Engineer",
      "Platform Engineer",
      "Data  Engineer",
    ]);
  });

  it("returns an empty array for blank input", () => {
    assert.deepEqual(parseTargetRoles(""), []);
    assert.deepEqual(parseTargetRoles(" , ,"), []);
  });

  it("formats an array as comma-separated text that parses back to the same roles", () => {
    const text = formatTargetRoles(profile.targetRoles);
    assert.equal(text, "Backend Engineer, Platform Engineer");
    assert.deepEqual(parseTargetRoles(text), profile.targetRoles);
  });
});

describe("toFormValues", () => {
  it("gives an empty form for a null (not yet saved) profile", () => {
    assert.deepEqual(toFormValues(null), emptyForm);
  });

  it("renders every saved value into the form", () => {
    assert.deepEqual(toFormValues(profile), {
      headline: "Senior Backend Engineer",
      experienceSummary: "Ten years of TypeScript.\n\nLed a platform team.",
      location: "Athens, Greece",
      targetRoles: "Backend Engineer, Platform Engineer",
      workModel: "hybrid",
      careerInstructions: "Prefer product companies.",
    });
  });

  it("renders null fields as blank controls", () => {
    const partial = { ...profile, headline: null, location: null, workModel: null, targetRoles: [] };
    const values = toFormValues(partial);
    assert.equal(values.headline, "");
    assert.equal(values.location, "");
    assert.equal(values.workModel, "");
    assert.equal(values.targetRoles, "");
  });
});

describe("toProfileInput (PUT body)", () => {
  it("always has exactly the six contract keys, never id or updatedAt", () => {
    const body = toProfileInput(toFormValues(profile));
    assert.deepEqual(Object.keys(body).sort(), [
      "careerInstructions",
      "experienceSummary",
      "headline",
      "location",
      "targetRoles",
      "workModel",
    ]);
  });

  it("round-trips a saved profile", () => {
    const { updatedAt: _u, ...input } = profile;
    assert.deepEqual(toProfileInput(toFormValues(profile)), input);
  });

  it("sends blank text as null, no roles as [], and 'Not specified' as null", () => {
    assert.deepEqual(toProfileInput({ ...emptyForm, headline: "   ", careerInstructions: "\n" }), {
      headline: null,
      experienceSummary: null,
      location: null,
      targetRoles: [],
      workModel: null,
      careerInstructions: null,
    });
  });

  it("sends target roles as an array, never as a comma-separated string", () => {
    const body = toProfileInput({ ...emptyForm, targetRoles: "Backend Engineer, Platform Engineer" });
    assert.ok(Array.isArray(body.targetRoles));
    assert.deepEqual(body.targetRoles, ["Backend Engineer", "Platform Engineer"]);
  });

  it("leaves other whitespace normalization to the backend", () => {
    const body = toProfileInput({ ...emptyForm, headline: "  Senior   Engineer " });
    assert.equal(body.headline, "  Senior   Engineer ");
  });
});

describe("mergeSavedValues", () => {
  it("adopts the server's normalized values for untouched fields", () => {
    const submitted = { ...emptyForm, headline: "  Senior   Engineer ", targetRoles: "A, a" };
    const saved = { ...emptyForm, headline: "Senior Engineer", targetRoles: "A" };
    assert.deepEqual(mergeSavedValues(submitted, submitted, saved), saved);
  });

  it("keeps fields the user edited while the save was in flight", () => {
    const submitted = { ...emptyForm, headline: "Senior Engineer", location: "Athens" };
    const current = { ...submitted, location: "Athens, Greece" };
    const saved = { ...submitted };
    const merged = mergeSavedValues(current, submitted, saved);
    assert.equal(merged.location, "Athens, Greece");
    assert.equal(merged.headline, "Senior Engineer");
    assert.equal(formValuesEqual(merged, saved), false);
  });
});

describe("parseProfileResponse", () => {
  it("accepts null (no profile yet)", () => {
    assert.equal(parseProfileResponse(null), null);
  });

  it("accepts a valid profile and drops unknown keys", () => {
    assert.deepEqual(parseProfileResponse({ ...profile, id: 1 }), profile);
  });

  it("rejects bodies that break the contract", () => {
    const bad: unknown[] = [
      undefined,
      "profile",
      [],
      { ...profile, headline: 5 },
      { ...profile, targetRoles: "Backend Engineer" },
      { ...profile, targetRoles: [1] },
      { ...profile, workModel: "office" },
      { ...profile, updatedAt: undefined },
      { ...profile, updatedAt: "not a date" },
    ];
    for (const body of bad) assert.equal(parseProfileResponse(body), undefined, JSON.stringify(body));
  });
});

describe("groupFieldErrors", () => {
  it("attaches errors to controls, and targetRoles[i] to the target-roles control", () => {
    const { fieldErrors, general } = groupFieldErrors([
      { field: "headline", message: "must be at most 200 characters" },
      { field: "targetRoles[1]", message: "must not be empty" },
      { field: "targetRoles", message: "must contain at most 20 roles" },
      { field: "workModel", message: "must be one of remote, hybrid, onsite, flexible, or null" },
    ]);
    assert.deepEqual(fieldErrors, {
      headline: ["Must be at most 200 characters."],
      targetRoles: ["Role 2 must not be empty.", "Must contain at most 20 roles."],
      workModel: ["Must be one of remote, hybrid, onsite, flexible, or null."],
    });
    assert.deepEqual(general, []);
  });

  it("returns errors it cannot map to a control as general messages", () => {
    const { fieldErrors, general } = groupFieldErrors([
      { field: "body", message: "must be a JSON object" },
      { field: "id", message: "is not an allowed field" },
    ]);
    assert.deepEqual(fieldErrors, {});
    assert.deepEqual(general, ["body must be a JSON object.", "id is not an allowed field."]);
  });
});

describe("characterCount", () => {
  it("counts code points like the backend", () => {
    assert.equal(characterCount("abc"), 3);
    assert.equal(characterCount("😀😀"), 2);
  });
});
