import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EVIDENCE_LIMITS,
  parseEvidenceId,
  validateEvidenceCreate,
  validateEvidenceReplace,
  validateReview,
  validateSkillIds,
} from "../src/evidence-validation.js";
import { EVIDENCE_SOURCE_TYPES } from "../src/schema.js";

const full = {
  type: "personal_project",
  title: "JobFlow",
  description: "Local job-search tool.\n\nExpress + React.",
  url: "https://example.com/project",
};

type Result = { ok: true; value: unknown } | { ok: false; errors: { field: string; message: string }[] };

function fields(result: Result) {
  assert.equal(result.ok, false, "expected a validation failure");
  return result.ok ? [] : result.errors.map((e) => e.field).sort();
}

// Asserts the patch is rejected by both create and replace.
function rejects(patch: Record<string, unknown>, expected: string[]) {
  assert.deepEqual(fields(validateEvidenceCreate({ ...full, ...patch })), [...expected].sort(), `create ${JSON.stringify(patch)}`);
  assert.deepEqual(fields(validateEvidenceReplace({ ...full, ...patch })), [...expected].sort(), `replace ${JSON.stringify(patch)}`);
}

function accepted(body: unknown) {
  const result = validateEvidenceCreate(body);
  assert.ok(result.ok, JSON.stringify(result));
  const replaced = validateEvidenceReplace({ description: null, url: null, ...(body as object) });
  assert.ok(replaced.ok, JSON.stringify(replaced));
  assert.deepEqual(replaced.value, result.value);
  return result.value;
}

const urlOf = (url: unknown) => accepted({ ...full, url }).url;

describe("validateEvidenceCreate / validateEvidenceReplace", () => {
  it("accepts a complete source unchanged", () => {
    assert.deepEqual(accepted(full), full);
  });

  it("create requires only type and title; description and url default to null", () => {
    assert.deepEqual(validateEvidenceCreate({ type: "cv", title: "CV" }), {
      ok: true,
      value: { type: "cv", title: "CV", description: null, url: null },
    });
    assert.deepEqual(fields(validateEvidenceCreate({})), ["title", "type"]);
  });

  it("replace requires all four keys, naming each missing one", () => {
    assert.deepEqual(fields(validateEvidenceReplace({})), ["description", "title", "type", "url"]);
    assert.deepEqual(fields(validateEvidenceReplace({ type: "cv", title: "CV" })), ["description", "url"]);
    assert.ok(validateEvidenceReplace({ type: "cv", title: "CV", description: null, url: null }).ok);
  });

  it("rejects non-object bodies", () => {
    for (const body of [undefined, null, [], [full], "x", 1, true]) {
      assert.deepEqual(fields(validateEvidenceCreate(body)), ["body"]);
      assert.deepEqual(fields(validateEvidenceReplace(body)), ["body"]);
    }
  });

  it("rejects unknown keys, including server-controlled and verification fields", () => {
    for (const key of ["id", "origin", "reviewedAt", "createdAt", "updatedAt", "skillIds", "verified", "verifiedAt", "verification", "confidence"]) {
      rejects({ [key]: key === "origin" ? "manual" : null }, [key]);
    }
  });

  describe("type", () => {
    it("accepts every approved type", () => {
      for (const type of EVIDENCE_SOURCE_TYPES) assert.equal(accepted({ ...full, type }).type, type);
    });

    it("rejects anything else, without trimming or case folding", () => {
      for (const type of [null, "", "CV", "Portfolio", " cv", "cv ", "project", "github", 1, ["cv"]]) {
        rejects({ type }, ["type"]);
      }
    });
  });

  describe("title", () => {
    it("collapses and trims ASCII whitespace, keeping other characters as entered", () => {
      assert.equal(accepted({ ...full, title: "  Job\t\tFlow \r\n v2 " }).title, "Job Flow v2");
      assert.equal(accepted({ ...full, title: "Job Flow" }).title, "Job Flow");
      assert.equal(accepted({ ...full, title: "Ünïcödé — C#" }).title, "Ünïcödé — C#");
    });

    it("allows 200 code points after normalization and rejects 201", () => {
      assert.equal(accepted({ ...full, title: "a".repeat(200) }).title.length, 200);
      assert.equal(accepted({ ...full, title: `  ${"a".repeat(200)}  ` }).title.length, 200);
      // 200 astral characters are 400 UTF-16 code units but 200 code points.
      accepted({ ...full, title: "😀".repeat(200) });
      rejects({ title: "a".repeat(201) }, ["title"]);
      rejects({ title: "😀".repeat(201) }, ["title"]);
    });

    it("rejects missing, non-string, blank and Unicode-whitespace-only titles", () => {
      for (const title of [null, 7, ["x"], "", " ", " \t\n\r\f\v ", " ", "　", " \u0085 ", "﻿"]) {
        rejects({ title }, ["title"]);
      }
    });

    it("rejects control characters and invalid Unicode", () => {
      for (const title of ["Job\u0000Flow", "Job\u0007", "\u007F", "Job\uD800", "\uDC00Flow"]) rejects({ title }, ["title"]);
    });
  });

  describe("description", () => {
    it("keeps line breaks, trims the ends and unifies CRLF and CR", () => {
      assert.equal(accepted({ ...full, description: "  First.\r\n\r\nSecond.\rThird.  \n" }).description, "First.\n\nSecond.\nThird.");
    });

    it("stores null, empty and blank descriptions as null", () => {
      for (const description of [null, "", "   ", "\n\n\t"]) assert.equal(accepted({ ...full, description }).description, null);
    });

    it("allows 5,000 code points after trimming and rejects 5,001", () => {
      accepted({ ...full, description: "a".repeat(5000) });
      accepted({ ...full, description: ` ${"😀".repeat(5000)} ` });
      rejects({ description: "a".repeat(5001) }, ["description"]);
      rejects({ description: "😀".repeat(5001) }, ["description"]);
    });

    it("rejects non-strings, control characters and invalid Unicode", () => {
      for (const description of [1, ["x"], {}, "a\u0000b", "a\u001Bb", "a\uD800"]) rejects({ description }, ["description"]);
    });
  });

  describe("url", () => {
    it("accepts http and https in any case and stores the canonical href", () => {
      assert.equal(urlOf("https://example.com/a?b=c#d"), "https://example.com/a?b=c#d");
      assert.equal(urlOf("HTTP://EXAMPLE.COM"), "http://example.com/");
      assert.equal(urlOf("Https://Example.com:443/Path"), "https://example.com/Path");
      assert.equal(urlOf("http://example.com:8080/x y".replace(" ", "%20")), "http://example.com:8080/x%20y");
      assert.equal(urlOf("  https://example.com/x  "), "https://example.com/x");
      // Internationalized names are stored in punycode, so look-alikes are visible.
      assert.equal(urlOf("https://bücher.example/ü"), "https://xn--bcher-kva.example/%C3%BC");
      assert.equal(urlOf("http://127.0.0.1:3000/"), "http://127.0.0.1:3000/");
      assert.equal(urlOf("http://[::1]/"), "http://[::1]/");
    });

    it("stores null, empty and blank URLs as null", () => {
      for (const url of [null, "", "   "]) assert.equal(urlOf(url), null);
    });

    it("rejects other schemes and scheme-less or malformed values", () => {
      for (const url of [
        "example.com",
        "//example.com",
        "/path",
        "ftp://example.com",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "mailto:a@example.com",
        "data:text/html,x",
        "ws://example.com",
        "http:example.com",
        "https:/example.com",
        "http:///example.com",
        "https://",
        "https://?q",
        "https://#f",
        "https://example.com:99999/",
        "https://exa mple.com",
        "https://[::1/",
        "httpx://example.com",
        "http//example.com",
      ]) {
        rejects({ url }, ["url"]);
      }
    });

    it("rejects user info, even empty", () => {
      for (const url of ["https://user@example.com", "https://user:pw@example.com", "https://:pw@example.com", "https://@example.com", "https://a@b@example.com"]) {
        rejects({ url }, ["url"]);
      }
    });

    it("rejects characters the parser would silently strip or reinterpret", () => {
      for (const url of [
        "https://example.com/a b",
        "https://exa\tmple.com",
        "https://example.com/a\nb",
        "https://example.com/a\rb",
        "https:\\\\example.com",
        "https://example.com\\path",
        "https://example.com/\u0000",
        "https://example.com/\u007F",
        "https://example.com/\u0085",
        "https://example.com/\u009F",
        "https://example.com/\uD800",
      ]) {
        rejects({ url }, ["url"]);
      }
    });

    it("limits the canonical form to 2,048 characters", () => {
      const prefix = "https://example.com/";
      assert.equal(urlOf(prefix + "a".repeat(EVIDENCE_LIMITS.url - prefix.length))?.length, 2048);
      rejects({ url: prefix + "a".repeat(EVIDENCE_LIMITS.url - prefix.length + 1) }, ["url"]);
      // 2,047 typed characters whose canonical form grows past the limit.
      rejects({ url: prefix + "ü".repeat(1000) }, ["url"]);
      // A typed form over the limit whose canonical form fits is accepted.
      assert.equal(urlOf("HTTPS://EXAMPLE.COM:443/" + "a".repeat(2028))?.length, 2048);
    });

    it("rejects non-strings", () => {
      for (const url of [1, true, ["https://example.com"], {}]) rejects({ url }, ["url"]);
    });
  });

  it("reports every problem in one result", () => {
    assert.deepEqual(fields(validateEvidenceReplace({ type: "x", title: "", description: 1, url: "ftp://x", origin: "manual" })), [
      "description",
      "origin",
      "title",
      "type",
      "url",
    ]);
  });
});

describe("validateSkillIds", () => {
  it("accepts [] and distinct ids in any order, keeping the order given", () => {
    assert.deepEqual(validateSkillIds({ skillIds: [] }), { ok: true, value: [] });
    assert.deepEqual(validateSkillIds({ skillIds: [5, 2, 2147483647, 1] }), { ok: true, value: [5, 2, 2147483647, 1] });
  });

  it("allows 500 ids and rejects 501", () => {
    const ids = Array.from({ length: 501 }, (_, i) => i + 1);
    assert.ok(validateSkillIds({ skillIds: ids.slice(0, 500) }).ok);
    assert.deepEqual(fields(validateSkillIds({ skillIds: ids })), ["skillIds"]);
  });

  it("rejects stringified, fractional, out-of-range and non-number ids, naming each item", () => {
    for (const id of ["1", "abc", 1.5, 0, -1, 2147483648, Number.MAX_SAFE_INTEGER, null, true, [1], {}]) {
      assert.deepEqual(fields(validateSkillIds({ skillIds: [3, id] })), ["skillIds[1]"], JSON.stringify(id));
    }
  });

  it("rejects duplicates instead of dropping them", () => {
    assert.deepEqual(fields(validateSkillIds({ skillIds: [2, 5, 2, 5, 7] })), ["skillIds[2]", "skillIds[3]"]);
  });

  it("requires an array under skillIds and nothing else", () => {
    assert.deepEqual(fields(validateSkillIds({})), ["skillIds"]);
    for (const skillIds of [null, "1,2", 1, { 0: 1 }]) assert.deepEqual(fields(validateSkillIds({ skillIds })), ["skillIds"]);
    assert.deepEqual(fields(validateSkillIds({ skillIds: [], reviewedAt: null })), ["reviewedAt"]);
    for (const body of [undefined, null, [1, 2], "x"]) assert.deepEqual(fields(validateSkillIds(body)), ["body"]);
  });
});

describe("validateReview", () => {
  it("accepts an updatedAt in the API's own serialization", () => {
    const expectedUpdatedAt = new Date("2026-10-29T12:00:00.123Z").toISOString();
    assert.deepEqual(validateReview({ expectedUpdatedAt }), { ok: true, value: { expectedUpdatedAt } });
  });

  it("rejects missing, unsupported and differently formatted values", () => {
    assert.deepEqual(fields(validateReview({})), ["expectedUpdatedAt"]);
    for (const expectedUpdatedAt of [
      null,
      1793283946484,
      "",
      "2026-10-29T12:00:00Z",
      "2026-10-29T12:00:00.1Z",
      "2026-10-29T12:00:00.123456Z",
      "2026-10-29T12:00:00.123+00:00",
      "2026-10-29 12:00:00.123Z",
      "2026-10-29T12:00:00.123z",
      "2026-02-30T12:00:00.000Z",
      "2026-13-01T00:00:00.000Z",
      "+012026-10-29T12:00:00.000Z",
      " 2026-10-29T12:00:00.123Z",
    ]) {
      assert.deepEqual(fields(validateReview({ expectedUpdatedAt })), ["expectedUpdatedAt"], JSON.stringify(expectedUpdatedAt));
    }
    assert.deepEqual(fields(validateReview({ expectedUpdatedAt: "2026-10-29T12:00:00.000Z", reviewedAt: "x", verified: true })), [
      "reviewedAt",
      "verified",
    ]);
    for (const body of [undefined, null, [], "x"]) assert.deepEqual(fields(validateReview(body)), ["body"]);
  });
});

describe("parseEvidenceId", () => {
  it("accepts canonical positive integers within PostgreSQL integer range", () => {
    for (const [raw, id] of [["1", 1], ["42", 42], ["2147483647", 2147483647]] as const) assert.equal(parseEvidenceId(raw), id);
  });

  it("rejects everything else", () => {
    for (const raw of ["", "0", "01", "-1", "+1", "1.0", "1e3", "0x1", " 1", "1 ", "abc", "2147483648", "99999999999"]) {
      assert.equal(parseEvidenceId(raw), null, raw);
    }
  });
});
