// Dependency-free unit tests for the skill conversions (node:test, Node's
// built-in TypeScript type stripping). Run with `npm test`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_SKILL_FORM,
  formatExperience,
  groupSkillFieldErrors,
  neighborId,
  parseOptionalInteger,
  parseSkill,
  parseSkillList,
  skillSummary,
  toggleContext,
  toSkillFormValues,
  toSkillInput,
  type Skill,
  type SkillFormValues,
} from "./skill.ts";

const skill: Skill = {
  id: 7,
  name: "PostgreSQL",
  experienceContexts: ["professional", "personal_project"],
  practicalConfidence: 4,
  interviewConfidence: 2,
  experienceMonths: 36,
  lastUsedYear: 2024,
  notes: "Schema design.\nQuery tuning.",
  createdAt: "2026-10-20T09:00:00.000Z",
  updatedAt: "2026-10-21T09:00:00.000Z",
};

const form = (overrides: Partial<SkillFormValues> = {}): SkillFormValues => ({
  ...EMPTY_SKILL_FORM,
  experienceContexts: [],
  ...overrides,
});

describe("toSkillFormValues", () => {
  it("returns an empty form for a new skill", () => {
    assert.deepEqual(toSkillFormValues(null), EMPTY_SKILL_FORM);
  });

  it("converts every field of a stored skill to text", () => {
    assert.deepEqual(toSkillFormValues(skill), {
      name: "PostgreSQL",
      experienceContexts: ["professional", "personal_project"],
      practicalConfidence: "4",
      interviewConfidence: "2",
      experienceMonths: "36",
      lastUsedYear: "2024",
      notes: "Schema design.\nQuery tuning.",
    });
  });

  it("shows null values as blank and copies the contexts array", () => {
    const values = toSkillFormValues({
      ...skill,
      experienceContexts: [],
      practicalConfidence: null,
      interviewConfidence: null,
      experienceMonths: null,
      lastUsedYear: null,
      notes: null,
    });
    assert.deepEqual(values, form({ name: "PostgreSQL" }));
    const copied = toSkillFormValues(skill);
    assert.notEqual(copied.experienceContexts, skill.experienceContexts);
  });

  it("round-trips through toSkillInput to all seven writable fields", () => {
    const result = toSkillInput(toSkillFormValues(skill));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(Object.keys(result.input).sort(), [
      "experienceContexts",
      "experienceMonths",
      "interviewConfidence",
      "lastUsedYear",
      "name",
      "notes",
      "practicalConfidence",
    ]);
    const { id, createdAt, updatedAt, ...writable } = skill;
    assert.deepEqual(result.input, writable);
  });
});

describe("parseOptionalInteger", () => {
  it("treats blank text as null", () => {
    assert.deepEqual(parseOptionalInteger(""), { ok: true, value: null });
    assert.deepEqual(parseOptionalInteger("   "), { ok: true, value: null });
  });

  it("accepts digits, ignoring surrounding spaces", () => {
    assert.deepEqual(parseOptionalInteger("0"), { ok: true, value: 0 });
    assert.deepEqual(parseOptionalInteger(" 36 "), { ok: true, value: 36 });
    assert.deepEqual(parseOptionalInteger("2024"), { ok: true, value: 2024 });
  });

  it("rejects anything that is not a whole number written in digits", () => {
    for (const text of ["3.5", "-1", "+2", "1e3", "abc", "12a", "0x10", "1 2", "١٢", "99999999999999999999"]) {
      assert.deepEqual(parseOptionalInteger(text), { ok: false }, text);
    }
  });

  it("leaves range checks to the backend", () => {
    assert.deepEqual(parseOptionalInteger("5000"), { ok: true, value: 5000 });
  });
});

describe("toSkillInput", () => {
  it("sends a minimal skill with explicit null and [] values", () => {
    assert.deepEqual(toSkillInput(form({ name: "Go" })), {
      ok: true,
      input: {
        name: "Go",
        experienceContexts: [],
        practicalConfidence: null,
        interviewConfidence: null,
        experienceMonths: null,
        lastUsedYear: null,
        notes: null,
      },
    });
  });

  it("keeps practical and interview confidence independent", () => {
    const result = toSkillInput(form({ name: "Go", practicalConfidence: "5", interviewConfidence: "1" }));
    assert.ok(result.ok);
    assert.equal(result.input.practicalConfidence, 5);
    assert.equal(result.input.interviewConfidence, 1);
    const onlyInterview = toSkillInput(form({ name: "Go", interviewConfidence: "3" }));
    assert.ok(onlyInterview.ok);
    assert.equal(onlyInterview.input.practicalConfidence, null);
    assert.equal(onlyInterview.input.interviewConfidence, 3);
  });

  it("sends multiple contexts in canonical order", () => {
    const result = toSkillInput(form({ name: "Go", experienceContexts: ["learning", "professional", "academic"] }));
    assert.ok(result.ok);
    assert.deepEqual(result.input.experienceContexts, ["professional", "academic", "learning"]);
  });

  it("sends the name as typed and leaves normalization to the backend", () => {
    const result = toSkillInput(form({ name: "  Type   Script " }));
    assert.ok(result.ok);
    assert.equal(result.input.name, "  Type   Script ");
  });

  it("sends blank notes as null and other notes unchanged", () => {
    const blank = toSkillInput(form({ name: "Go", notes: " \n " }));
    assert.ok(blank.ok);
    assert.equal(blank.input.notes, null);
    const notes = toSkillInput(form({ name: "Go", notes: "  line one\nline two  " }));
    assert.ok(notes.ok);
    assert.equal(notes.input.notes, "  line one\nline two  ");
  });

  it("does not check name presence or length (the backend does)", () => {
    const result = toSkillInput(form({ name: "" }));
    assert.ok(result.ok);
    assert.equal(result.input.name, "");
  });

  it("reports every numeric field with invalid text and does not change the values", () => {
    const values = form({
      name: "Go",
      practicalConfidence: "4",
      experienceMonths: "2.5",
      lastUsedYear: "twenty",
    });
    const before = structuredClone(values);
    const result = toSkillInput(values);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(Object.keys(result.fieldErrors).sort(), ["experienceMonths", "lastUsedYear"]);
    assert.deepEqual(values, before);
  });
});

describe("toggleContext", () => {
  it("adds and removes a context, keeping canonical order", () => {
    assert.deepEqual(toggleContext([], "learning", true), ["learning"]);
    assert.deepEqual(toggleContext(["learning"], "professional", true), ["professional", "learning"]);
    assert.deepEqual(toggleContext(["professional", "learning"], "professional", false), ["learning"]);
    assert.deepEqual(toggleContext(["learning"], "learning", false), []);
  });

  it("does not add a context twice", () => {
    assert.deepEqual(toggleContext(["academic"], "academic", true), ["academic"]);
  });
});

describe("parseSkill", () => {
  it("accepts a valid skill and nulls", () => {
    assert.deepEqual(parseSkill(skill), skill);
    const empty = {
      ...skill,
      experienceContexts: [],
      practicalConfidence: null,
      interviewConfidence: null,
      experienceMonths: null,
      lastUsedYear: null,
      notes: null,
    };
    assert.deepEqual(parseSkill(empty), empty);
  });

  it("rejects bodies that break the contract", () => {
    const bad: unknown[] = [
      null,
      [],
      "PostgreSQL",
      { ...skill, id: "7" },
      { ...skill, id: 0 },
      { ...skill, id: 1.5 },
      { ...skill, name: null },
      { ...skill, experienceContexts: null },
      { ...skill, experienceContexts: ["work"] },
      { ...skill, experienceContexts: ["academic", "academic"] },
      { ...skill, practicalConfidence: "4" },
      { ...skill, interviewConfidence: 2.5 },
      { ...skill, experienceMonths: "36" },
      { ...skill, lastUsedYear: undefined },
      { ...skill, notes: 1 },
      { ...skill, createdAt: "yesterday" },
      { ...skill, updatedAt: undefined },
    ];
    for (const body of bad) assert.equal(parseSkill(body), undefined, JSON.stringify(body));
  });
});

describe("parseSkillList", () => {
  it("accepts an empty list", () => {
    assert.deepEqual(parseSkillList([]), []);
  });

  it("preserves the server order exactly", () => {
    // Server order: normalized name, then id. Not what a JS sort would give.
    const list = [
      { ...skill, id: 3, name: "c#" },
      { ...skill, id: 1, name: "C++" },
      { ...skill, id: 2, name: "Ägile" },
      { ...skill, id: 9, name: "agile" },
    ];
    assert.deepEqual(
      parseSkillList(list)?.map((s) => s.id),
      [3, 1, 2, 9]
    );
  });

  it("rejects a non-array, any invalid entry, or repeated ids", () => {
    assert.equal(parseSkillList({ skills: [] }), undefined);
    assert.equal(parseSkillList(null), undefined);
    assert.equal(parseSkillList([skill, { ...skill, id: 8, name: 3 }]), undefined);
    assert.equal(parseSkillList([skill, skill]), undefined);
  });
});

describe("groupSkillFieldErrors", () => {
  it("attaches messages to their controls", () => {
    const { fieldErrors, general } = groupSkillFieldErrors([
      { field: "name", message: "must not be empty" },
      { field: "practicalConfidence", message: "must be an integer from 1 to 5, or null" },
      { field: "lastUsedYear", message: "must be an integer from 1950 to 2026, or null" },
      { field: "notes", message: "must be at most 2000 characters" },
    ]);
    assert.deepEqual(fieldErrors, {
      name: ["Must not be empty."],
      practicalConfidence: ["Must be an integer from 1 to 5, or null."],
      lastUsedYear: ["Must be an integer from 1950 to 2026, or null."],
      notes: ["Must be at most 2000 characters."],
    });
    assert.deepEqual(general, []);
  });

  it("groups experienceContexts[i] entries on the context group", () => {
    const { fieldErrors } = groupSkillFieldErrors([
      { field: "experienceContexts[0]", message: "must be one of professional, personal_project, academic, learning" },
      { field: "experienceContexts[2]", message: "must not repeat an earlier value" },
    ]);
    assert.deepEqual(fieldErrors.experienceContexts, [
      "Selection 1 must be one of professional, personal_project, academic, learning.",
      "Selection 3 must not repeat an earlier value.",
    ]);
  });

  it("returns errors that match no control as general", () => {
    const { fieldErrors, general } = groupSkillFieldErrors([
      { field: "body", message: "must be a JSON object" },
      { field: "id", message: "is not an allowed field" },
    ]);
    assert.deepEqual(fieldErrors, {});
    assert.deepEqual(general, ["body must be a JSON object.", "id is not an allowed field."]);
  });
});

describe("display helpers", () => {
  it("formats experience months", () => {
    assert.equal(formatExperience(0), "Less than a month");
    assert.equal(formatExperience(1), "1 month");
    assert.equal(formatExperience(12), "1 year");
    assert.equal(formatExperience(14), "1 year 2 months");
    assert.equal(formatExperience(36), "3 years");
  });

  it("summarizes only the fields that have values", () => {
    assert.deepEqual(skillSummary(skill), [
      "Practical confidence 4/5",
      "Interview confidence 2/5",
      "3 years experience",
      "Last used 2024",
      "Professional work, Personal projects",
    ]);
    assert.deepEqual(
      skillSummary({ ...skill, practicalConfidence: null, experienceMonths: null, lastUsedYear: null, experienceContexts: [] }),
      ["Interview confidence 2/5"]
    );
  });

  it("finds the row to focus after a skill disappears", () => {
    const list = [1, 2, 3].map((id) => ({ ...skill, id }));
    assert.equal(neighborId(list, 2), 3);
    assert.equal(neighborId(list, 3), 2);
    assert.equal(neighborId([list[0]], 1), null);
    assert.equal(neighborId(list, 42), null);
  });
});
