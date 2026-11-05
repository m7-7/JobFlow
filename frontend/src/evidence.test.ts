// Dependency-free unit tests for the evidence domain helpers (node:test,
// Node's built-in TypeScript type stripping). Run with `npm test`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_EVIDENCE_DRAFT,
  EVIDENCE_SOURCE_TYPES,
  SOURCE_TYPE_OPTIONS,
  groupEvidenceFieldErrors,
  normalizeSkillIds,
  parseEvidence,
  parseEvidenceList,
  sameSkillIds,
  toEvidenceDraft,
  toggleSkillId,
  validateEvidenceDraft,
  type Evidence,
  type EvidenceDraft,
} from "./evidence.ts";

const evidence: Evidence = {
  id: 3,
  type: "personal_project",
  title: "JobFlow",
  description: "Job search tracker.\nTypeScript and PostgreSQL.",
  url: "https://example.com/jobflow",
  origin: "manual",
  reviewedAt: null,
  skillIds: [2, 5],
  createdAt: "2026-10-20T09:00:00.000Z",
  updatedAt: "2026-10-21T09:00:00.000Z",
};

const draft = (overrides: Partial<EvidenceDraft> = {}): EvidenceDraft => ({
  ...EMPTY_EVIDENCE_DRAFT,
  title: "JobFlow",
  ...overrides,
});

describe("source types", () => {
  it("offers exactly the backend's five types, each with a label", () => {
    assert.deepEqual(EVIDENCE_SOURCE_TYPES, ["professional_experience", "personal_project", "cv", "portfolio", "other"]);
    assert.deepEqual(
      SOURCE_TYPE_OPTIONS.map((o) => o.value),
      [...EVIDENCE_SOURCE_TYPES]
    );
    assert.ok(SOURCE_TYPE_OPTIONS.every((o) => o.label.length > 0));
  });
});

describe("toEvidenceDraft", () => {
  it("returns an empty draft for a new source", () => {
    assert.deepEqual(toEvidenceDraft(null), EMPTY_EVIDENCE_DRAFT);
    assert.notEqual(toEvidenceDraft(null), EMPTY_EVIDENCE_DRAFT);
  });

  it("holds only the four content fields, nulls as blank", () => {
    assert.deepEqual(toEvidenceDraft({ ...evidence, description: null, url: null }), {
      type: "personal_project",
      title: "JobFlow",
      description: "",
      url: "",
    });
  });
});

describe("validateEvidenceDraft", () => {
  it("round-trips a stored source to an identical normalized value", () => {
    const result = validateEvidenceDraft(toEvidenceDraft(evidence));
    assert.ok(result.ok);
    assert.deepEqual(result.normalized, {
      type: evidence.type,
      title: evidence.title,
      description: evidence.description,
      url: evidence.url,
    });
  });

  it("sends the typed text, with blank optional fields as null", () => {
    const result = validateEvidenceDraft(draft({ title: "  Job  Flow ", description: "  ", url: " " }));
    assert.ok(result.ok);
    assert.deepEqual(result.input, { type: "professional_experience", title: "  Job  Flow ", description: null, url: null });
    assert.deepEqual(result.normalized, { type: "professional_experience", title: "Job Flow", description: null, url: null });
  });

  it("normalizes like the backend: ASCII whitespace in titles, CRLF and ends in descriptions, canonical URLs", () => {
    const result = validateEvidenceDraft(
      draft({ title: "a\t\n b", description: "\r\n  line 1\r\nline 2  \n", url: " HTTPS://Example.COM " })
    );
    assert.ok(result.ok);
    assert.equal(result.normalized.title, "a b");
    assert.equal(result.normalized.description, "line 1\nline 2");
    assert.equal(result.normalized.url, "https://example.com/");
  });

  it("keeps non-ASCII spaces inside a title, as the backend does", () => {
    const result = validateEvidenceDraft(draft({ title: " Go " }));
    assert.ok(result.ok);
    assert.equal(result.normalized.title, " Go ");
  });

  it("requires a title that is not only whitespace", () => {
    for (const title of ["", "   ", "  ", "﻿"]) {
      const result = validateEvidenceDraft(draft({ title }));
      assert.ok(!result.ok, JSON.stringify(title));
      assert.ok(result.fieldErrors.title);
    }
  });

  it("enforces the code-point limits after normalization", () => {
    assert.ok(validateEvidenceDraft(draft({ title: "x".repeat(200) })).ok);
    assert.ok(validateEvidenceDraft(draft({ title: " " + "x".repeat(200) + " " })).ok);
    assert.ok(validateEvidenceDraft(draft({ title: "😀".repeat(200) })).ok); // 400 UTF-16 units
    assert.ok(!validateEvidenceDraft(draft({ title: "x".repeat(201) })).ok);
    assert.ok(validateEvidenceDraft(draft({ description: "x".repeat(5000) })).ok);
    const long = validateEvidenceDraft(draft({ description: "x".repeat(5001) }));
    assert.ok(!long.ok && long.fieldErrors.description);
    const longUrl = validateEvidenceDraft(draft({ url: "https://example.com/" + "a".repeat(2030) }));
    assert.ok(!longUrl.ok && longUrl.fieldErrors.url);
  });

  it("rejects control characters and lone surrogates", () => {
    for (const field of ["title", "description", "url"] as const) {
      for (const bad of ["a\u0000b", "a\u0007b", "a\uD800b"]) {
        const result = validateEvidenceDraft(draft({ [field]: field === "url" ? `https://x.test/${bad}` : bad }));
        assert.ok(!result.ok && result.fieldErrors[field], `${field} ${JSON.stringify(bad)}`);
      }
    }
    assert.ok(validateEvidenceDraft(draft({ description: "tab\there\nline" })).ok);
  });

  it("accepts absolute http(s) URLs and rejects what the backend rejects", () => {
    for (const url of ["http://example.com", "https://example.com/a?b=c#d", "https://例え.jp/パス"]) {
      assert.ok(validateEvidenceDraft(draft({ url })).ok, url);
    }
    for (const url of [
      "example.com",
      "ftp://example.com",
      "javascript:alert(1)",
      "http:example.com",
      "https:/example.com",
      "http:///example.com",
      "https://user:pw@example.com",
      "https://@example.com",
      "https://exa mple.com",
      "https://example.com\\path",
      "https://",
    ]) {
      const result = validateEvidenceDraft(draft({ url }));
      assert.ok(!result.ok && result.fieldErrors.url, url);
    }
  });

  it("rejects a type outside the list and reports every invalid field at once", () => {
    const result = validateEvidenceDraft({ type: "certificate" as never, title: "", description: "", url: "nope" });
    assert.ok(!result.ok);
    assert.deepEqual(Object.keys(result.fieldErrors).sort(), ["title", "type", "url"]);
  });

  it("does not modify the draft", () => {
    const d = draft({ title: "  x  ", url: " https://a.test " });
    const copy = { ...d };
    validateEvidenceDraft(d);
    assert.deepEqual(d, copy);
  });
});

describe("skill-id helpers", () => {
  it("normalizes to ascending, unique ids without changing the input", () => {
    const ids = [5, 2, 5, 9];
    assert.deepEqual(normalizeSkillIds(ids), [2, 5, 9]);
    assert.deepEqual(ids, [5, 2, 5, 9]);
  });

  it("compares sets regardless of order", () => {
    assert.equal(sameSkillIds([3, 1], [1, 3]), true);
    assert.equal(sameSkillIds([], []), true);
    assert.equal(sameSkillIds([1], []), false);
    assert.equal(sameSkillIds([1, 2], [1, 3]), false);
  });

  it("toggles one id and keeps the set canonical", () => {
    assert.deepEqual(toggleSkillId([5, 2], 3, true), [2, 3, 5]);
    assert.deepEqual(toggleSkillId([2, 3, 5], 3, false), [2, 5]);
    assert.deepEqual(toggleSkillId([2], 2, true), [2]);
    assert.deepEqual(toggleSkillId([2], 2, false), []);
  });
});

describe("parseEvidence", () => {
  it("accepts a contract-conforming source and copies skillIds", () => {
    const body = structuredClone(evidence);
    const parsed = parseEvidence(body);
    assert.deepEqual(parsed, evidence);
    assert.notEqual(parsed?.skillIds, body.skillIds);
  });

  it("accepts nulls, an empty skill set and a review timestamp", () => {
    const body = { ...evidence, description: null, url: null, skillIds: [], reviewedAt: "2026-10-22T08:00:00.000Z" };
    assert.deepEqual(parseEvidence(body), body);
  });

  it("drops unknown keys", () => {
    const parsed = parseEvidence({ ...evidence, verified: true });
    assert.deepEqual(parsed && Object.keys(parsed).sort(), Object.keys(evidence).sort());
  });

  it("rejects bodies that break the contract", () => {
    const broken: unknown[] = [
      null,
      [],
      "x",
      { ...evidence, id: "3" },
      { ...evidence, id: 0 },
      { ...evidence, type: "certificate" },
      { ...evidence, title: null },
      { ...evidence, description: 1 },
      { ...evidence, url: undefined },
      { ...evidence, origin: "imported" },
      { ...evidence, reviewedAt: "yesterday" },
      { ...evidence, skillIds: null },
      { ...evidence, skillIds: [1, 1] },
      { ...evidence, skillIds: ["1"] },
      { ...evidence, skillIds: [1.5] },
      { ...evidence, createdAt: "2026-10-20T09:00:00Z" },
      { ...evidence, updatedAt: "2026-10-21T09:00:00.000+00:00" },
      { ...evidence, updatedAt: "2026-02-30T09:00:00.000Z" },
    ];
    const { origin: _o, ...missingOrigin } = evidence;
    broken.push(missingOrigin);
    for (const body of broken) assert.equal(parseEvidence(body), undefined, JSON.stringify(body));
  });
});

describe("parseEvidenceList", () => {
  it("keeps the server order", () => {
    const list = [
      { ...evidence, id: 9 },
      { ...evidence, id: 2 },
    ];
    assert.deepEqual(
      parseEvidenceList(list)?.map((e) => e.id),
      [9, 2]
    );
    assert.deepEqual(parseEvidenceList([]), []);
  });

  it("rejects non-arrays, any bad entry and repeated ids", () => {
    assert.equal(parseEvidenceList({ evidence: [] }), undefined);
    assert.equal(parseEvidenceList([evidence, { ...evidence, id: 4, type: "x" }]), undefined);
    assert.equal(parseEvidenceList([evidence, evidence]), undefined);
  });
});

describe("groupEvidenceFieldErrors", () => {
  it("attaches content and skill-link details to their controls", () => {
    const grouped = groupEvidenceFieldErrors([
      { field: "title", message: "must not be empty" },
      { field: "skillIds[1]", message: "does not refer to an existing skill" },
      { field: "skillIds", message: "must contain at most 500 skill ids" },
      { field: "origin", message: "is not an allowed field" },
    ]);
    assert.deepEqual(grouped.fieldErrors, {
      title: ["Must not be empty."],
      skillIds: ["Selection 2 does not refer to an existing skill.", "Must contain at most 500 skill ids."],
    });
    assert.deepEqual(grouped.general, ["origin is not an allowed field."]);
  });
});
