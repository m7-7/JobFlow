import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSkillId, validateSkillCreate, validateSkillReplace, type SkillInput } from "../src/skill-validation.js";

// Fixed clock so the "not in the future" rule for lastUsedYear is deterministic.
const NOW = new Date("2026-06-15T12:00:00Z");

const full = {
  name: "TypeScript",
  experienceContexts: ["professional", "personal_project"],
  practicalConfidence: 4,
  interviewConfidence: 3,
  experienceMonths: 36,
  lastUsedYear: 2026,
  notes: "Used daily.\n\nMostly backend.",
};

const cleared = {
  name: "TypeScript",
  experienceContexts: [],
  practicalConfidence: null,
  interviewConfidence: null,
  experienceMonths: null,
  lastUsedYear: null,
  notes: null,
};

const create = (body: unknown) => validateSkillCreate(body, NOW);
const replace = (body: unknown) => validateSkillReplace(body, NOW);

function fields(result: ReturnType<typeof create>) {
  assert.equal(result.ok, false, "expected a validation failure");
  return result.ok ? [] : result.errors.map((e) => e.field).sort();
}

// Asserts the field is rejected by both create and replace.
function rejects(patch: Record<string, unknown>, expected: string[]) {
  assert.deepEqual(fields(create({ ...full, ...patch })), [...expected].sort(), `create ${JSON.stringify(patch)}`);
  assert.deepEqual(fields(replace({ ...full, ...patch })), [...expected].sort(), `replace ${JSON.stringify(patch)}`);
}

function accepted(body: unknown) {
  const result = create(body);
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

describe("validateSkillCreate", () => {
  it("accepts a complete skill unchanged", () => {
    assert.deepEqual(create(full), { ok: true, value: full });
  });

  it("requires only name and fills the defaults", () => {
    assert.deepEqual(create({ name: "TypeScript" }), { ok: true, value: cleared });
  });

  it("accepts any subset of the optional fields", () => {
    assert.deepEqual(accepted({ name: "Go", interviewConfidence: 2 }), { ...cleared, name: "Go", interviewConfidence: 2 });
  });

  it("rejects a missing name", () => {
    assert.deepEqual(fields(create({})), ["name"]);
    assert.deepEqual(fields(create({ practicalConfidence: 3 })), ["name"]);
  });

  it("rejects explicit null experienceContexts", () => {
    assert.deepEqual(fields(create({ name: "Go", experienceContexts: null })), ["experienceContexts"]);
  });
});

describe("validateSkillReplace", () => {
  it("accepts a complete skill, and explicit null / [] to clear values", () => {
    assert.deepEqual(replace(full), { ok: true, value: full });
    assert.deepEqual(replace(cleared), { ok: true, value: cleared });
  });

  it("requires all seven keys, naming each missing one", () => {
    assert.deepEqual(fields(replace({ name: "Go" })), [
      "experienceContexts",
      "experienceMonths",
      "interviewConfidence",
      "lastUsedYear",
      "notes",
      "practicalConfidence",
    ]);
    const { notes: _n, ...noNotes } = full;
    assert.deepEqual(fields(replace(noNotes)), ["notes"]);
    const { name: _name, ...noName } = full;
    assert.deepEqual(fields(replace(noName)), ["name"]);
  });
});

describe("skill validation rules (create and replace)", () => {
  it("rejects non-object bodies", () => {
    for (const body of [undefined, null, "TypeScript", 42, true, [], [full]]) {
      assert.deepEqual(fields(create(body)), ["body"]);
      assert.deepEqual(fields(replace(body)), ["body"]);
    }
  });

  it("rejects unknown keys, including id and timestamps", () => {
    rejects({ id: 1, createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z", level: 3 }, [
      "createdAt",
      "id",
      "level",
      "updatedAt",
    ]);
    assert.deepEqual(fields(create({ name: "Go", id: 1 })), ["id"]);
  });

  describe("name", () => {
    it("must be a string", () => {
      for (const name of [null, 5, true, ["Go"], { name: "Go" }]) rejects({ name }, ["name"]);
    });

    it("collapses and trims ASCII whitespace", () => {
      assert.equal(accepted({ name: "  Type\t\tScript \r\n" }).name, "Type Script");
      assert.equal(accepted({ name: " Machine  Learning " }).name, "Machine Learning");
      assert.equal(accepted({ name: "\tGo\n" }).name, "Go");
    });

    it("keeps non-ASCII whitespace within a name as entered", () => {
      assert.equal(accepted({ name: "Type Script" }).name, "Type Script");
      assert.equal(accepted({ name: " Go　" }).name, " Go　");
      assert.equal(accepted({ name: " Type   Script " }).name, "Type   Script");
    });

    it("keeps case, punctuation and non-ASCII letters as entered", () => {
      for (const name of ["node.JS", "C#", "C++", "Ελληνικά", "日本語", "🚀 Rockets"]) {
        assert.equal(accepted({ name }).name, name);
      }
    });

    it("rejects empty, ASCII-blank and Unicode-whitespace-only names", () => {
      for (const name of ["", " ", "   ", "\t", "\r\n", " \t\n ", " ", " 　", "   ", "﻿"]) {
        rejects({ name }, ["name"]);
      }
    });

    it("rejects names made only of U+0085, with or without ASCII spaces", () => {
      // U+0085 is Unicode White_Space but is not matched by JS \s.
      for (const name of ["\u0085", "\u0085\u0085", " \u0085 ", "  \u0085\t"]) rejects({ name }, ["name"]);
    });

    it("keeps an internal U+0085 as entered", () => {
      assert.equal(accepted({ name: "Go\u0085Lang" }).name, "Go\u0085Lang");
      assert.equal(accepted({ name: " Go \u0085 Lang " }).name, "Go \u0085 Lang");
    });

    it("normalizes an embedded CRLF like any other ASCII whitespace run", () => {
      assert.equal(accepted({ name: "Go\r\nLang" }).name, "Go Lang");
      assert.equal(accepted({ name: "Go \r\n\t Lang" }).name, "Go Lang");
    });

    it("allows 100 characters (code points, after normalization) and rejects 101", () => {
      assert.equal(accepted({ name: "a".repeat(100) }).name.length, 100);
      accepted({ name: "é".repeat(100) });
      accepted({ name: "😀".repeat(100) });
      accepted({ name: `  ${"a".repeat(100)}  ` });
      accepted({ name: `${"a".repeat(50)}     ${"b".repeat(49)}` });
      rejects({ name: "a".repeat(101) }, ["name"]);
      rejects({ name: "😀".repeat(101) }, ["name"]);
      // Non-ASCII whitespace is not trimmed, so it counts toward the limit.
      rejects({ name: ` ${"a".repeat(100)}` }, ["name"]);
      rejects({ name: `${"a".repeat(100)} ` }, ["name"]);
    });

    it("rejects control characters and invalid Unicode", () => {
      for (const name of ["Go\u0000", "Go\u0007", "Go\u001B", "Go\u007F", "Go\uD800", "\uDC00Go", "Go\u000B", "Go\u000C"]) {
        rejects({ name }, ["name"]);
      }
    });
  });

  describe("experienceContexts", () => {
    it("accepts [], each allowed value and any order of distinct values", () => {
      for (const contexts of [[], ["professional"], ["personal_project"], ["academic"], ["learning"], ["learning", "academic", "professional", "personal_project"]]) {
        assert.deepEqual(accepted({ name: "Go", experienceContexts: contexts }).experienceContexts, contexts);
      }
    });

    it("must be an array", () => {
      for (const experienceContexts of [null, "professional", {}, { 0: "professional" }, 1, true]) {
        rejects({ experienceContexts }, ["experienceContexts"]);
      }
    });

    it("rejects values outside the allowed set, naming each item", () => {
      rejects({ experienceContexts: ["professional", "work"] }, ["experienceContexts[1]"]);
      rejects({ experienceContexts: ["Professional", 1, null, ["academic"], {}] }, [
        "experienceContexts[0]",
        "experienceContexts[1]",
        "experienceContexts[2]",
        "experienceContexts[3]",
        "experienceContexts[4]",
      ]);
    });

    it("rejects duplicates", () => {
      rejects({ experienceContexts: ["academic", "learning", "academic"] }, ["experienceContexts[2]"]);
    });
  });

  describe("integer fields", () => {
    const ranges = [
      { field: "practicalConfidence", min: 1, max: 5 },
      { field: "interviewConfidence", min: 1, max: 5 },
      { field: "experienceMonths", min: 0, max: 1200 },
      { field: "lastUsedYear", min: 1950, max: 2026 },
    ];

    for (const { field, min, max } of ranges) {
      it(`${field}: accepts null, ${min} and ${max}; rejects out-of-range and non-integers`, () => {
        for (const value of [null, min, max]) {
          assert.equal(accepted({ name: "Go", [field]: value })[field as keyof SkillInput], value);
        }
        for (const value of [min - 1, max + 1, min + 0.5, "3", String(min), true, [], {}, 1e400, -1e400]) {
          rejects({ [field]: value }, [field]);
        }
      });
    }

    it("keeps practical and interview confidence independent", () => {
      const value = accepted({ name: "Go", practicalConfidence: 5, interviewConfidence: 1 });
      assert.deepEqual([value.practicalConfidence, value.interviewConfidence], [5, 1]);
    });

    it("lastUsedYear may not be later than the current UTC year", () => {
      // 2026-12-31T23:30 in UTC-2 is already 2027 in UTC.
      const newYearUtc = new Date("2027-01-01T01:30:00Z");
      assert.ok(validateSkillCreate({ name: "Go", lastUsedYear: 2027 }, newYearUtc).ok);
      const lastDay2026 = new Date("2026-12-31T23:59:59Z");
      assert.equal(validateSkillCreate({ name: "Go", lastUsedYear: 2027 }, lastDay2026).ok, false);
      // The schema upper bound still applies far in the future.
      assert.equal(validateSkillCreate({ name: "Go", lastUsedYear: 2101 }, new Date("2200-01-01T00:00:00Z")).ok, false);
      assert.ok(validateSkillCreate({ name: "Go", lastUsedYear: 2100 }, new Date("2200-01-01T00:00:00Z")).ok);
    });

    it("defaults to the real clock", () => {
      const thisYear = new Date().getUTCFullYear();
      assert.ok(validateSkillCreate({ name: "Go", lastUsedYear: thisYear }).ok);
      assert.equal(validateSkillCreate({ name: "Go", lastUsedYear: thisYear + 1 }).ok, false);
      assert.equal(validateSkillReplace({ ...cleared, lastUsedYear: thisYear + 1 }).ok, false);
    });
  });

  describe("notes", () => {
    it("keeps line breaks, trims the ends and unifies CRLF", () => {
      assert.equal(accepted({ name: "Go", notes: "  Line one\r\n\r\nLine  two\n " }).notes, "Line one\n\nLine  two");
    });

    it("stores blank notes as null", () => {
      for (const notes of ["", "   ", "\n\t\n"]) assert.equal(accepted({ name: "Go", notes }).notes, null);
    });

    it("allows 2,000 characters after trimming and rejects 2,001", () => {
      assert.equal(accepted({ name: "Go", notes: "x".repeat(2000) }).notes?.length, 2000);
      accepted({ name: "Go", notes: `\n${"é".repeat(2000)}\n` });
      rejects({ notes: "x".repeat(2001) }, ["notes"]);
    });

    it("rejects non-strings, control characters and invalid Unicode", () => {
      for (const notes of [5, true, ["x"], {}, "a\u0000b", "a\u001Bb", "a\uD800b"]) rejects({ notes }, ["notes"]);
    });
  });

  it("reports every problem in one result", () => {
    const result = create({ name: " ", experienceContexts: ["x"], practicalConfidence: 9, notes: 1, id: 3 });
    assert.deepEqual(fields(result), ["experienceContexts[0]", "id", "name", "notes", "practicalConfidence"]);
    assert.ok(!result.ok && result.errors.every((e) => typeof e.message === "string" && e.message.length > 0));
  });
});

describe("parseSkillId", () => {
  it("accepts canonical positive integers within PostgreSQL integer range", () => {
    for (const [raw, id] of [["1", 1], ["42", 42], ["1000000", 1_000_000], ["2147483647", 2_147_483_647]] as const) {
      assert.equal(parseSkillId(raw), id);
    }
  });

  it("rejects everything else", () => {
    for (const raw of ["", "0", "00", "01", "-1", "+1", "1.0", "1.5", "1e3", "0x1", " 1", "1 ", "abc", "1a", "١", "2147483648", "9999999999", "99999999999", "1".repeat(400)]) {
      assert.equal(parseSkillId(raw), null, JSON.stringify(raw));
    }
  });
});
