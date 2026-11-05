// Save planning and reconciliation tests. Pure functions only: no fetch.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toEvidenceDraft, type Evidence, type EvidenceDraft } from "./evidence.ts";
import type { EvidenceApiFailure, EvidenceApiResult } from "./evidenceApi.ts";
import {
  afterContentStep,
  afterSkillsStep,
  planEvidenceSave,
  type EvidenceSavePlan,
  type EvidenceSaveRequest,
  type SkillCatalogue,
} from "./evidenceSave.ts";

const saved: Evidence = {
  id: 4,
  type: "professional_experience",
  title: "Backend engineer at Acme",
  description: "Payments.",
  url: "https://acme.example/",
  origin: "manual",
  reviewedAt: "2026-10-21T10:00:00.000Z",
  skillIds: [1, 3],
  createdAt: "2026-10-20T09:00:00.000Z",
  updatedAt: "2026-10-20T09:00:00.000Z",
};

const complete: SkillCatalogue = { status: "complete", skillIds: [1, 2, 3, 4] };
const unavailable: SkillCatalogue = { status: "unavailable" };

const req = (overrides: Partial<EvidenceSaveRequest> = {}): EvidenceSaveRequest => ({
  saved,
  draft: toEvidenceDraft(saved),
  intendedSkillIds: saved.skillIds,
  catalogue: complete,
  ...overrides,
});
const edited = (overrides: Partial<EvidenceDraft>) => ({ ...toEvidenceDraft(saved), ...overrides });

const ok = (data: Evidence): EvidenceApiResult<Evidence> => ({ ok: true, data });
const fail = (failure: EvidenceApiFailure): EvidenceApiResult<Evidence> => ({ ok: false, failure });

function writePlan(plan: EvidenceSavePlan) {
  assert.equal(plan.kind, "write");
  return plan as Extract<EvidenceSavePlan, { kind: "write" }>;
}

describe("planEvidenceSave", () => {
  it("issues nothing when neither content nor links changed", () => {
    assert.deepEqual(planEvidenceSave(req()), { kind: "unchanged" });
    assert.deepEqual(planEvidenceSave(req({ intendedSkillIds: [3, 1, 3] })), { kind: "unchanged" });
  });

  it("treats a whitespace-only difference the backend would normalize away as unchanged", () => {
    const draft = edited({ title: "  Backend   engineer at Acme ", description: "Payments.\r\n", url: " https://ACME.example " });
    assert.deepEqual(planEvidenceSave(req({ draft })), { kind: "unchanged" });
  });

  it("does not need the skill catalogue when links are unchanged", () => {
    assert.deepEqual(planEvidenceSave(req({ catalogue: unavailable })), { kind: "unchanged" });
  });

  it("plans a content-only replacement", () => {
    const plan = writePlan(planEvidenceSave(req({ draft: edited({ title: "Senior engineer at Acme" }) })));
    assert.deepEqual(plan.content, {
      kind: "replace",
      id: 4,
      input: { type: "professional_experience", title: "Senior engineer at Acme", description: "Payments.", url: "https://acme.example/" },
    });
    assert.equal(plan.skillIds, null);
    assert.equal(plan.skillsBlocked, null);
  });

  it("plans an association-only replacement with the complete intended set", () => {
    const plan = writePlan(planEvidenceSave(req({ intendedSkillIds: [4, 1, 3] })));
    assert.equal(plan.content, null);
    assert.deepEqual(plan.skillIds, [1, 3, 4]);
  });

  it("plans both, content first", () => {
    const plan = writePlan(planEvidenceSave(req({ draft: edited({ url: "" }), intendedSkillIds: [2] })));
    assert.equal(plan.content?.kind, "replace");
    assert.equal(plan.content?.input.url, null);
    assert.deepEqual(plan.skillIds, [2]);
  });

  it("sends an intentional empty set when the catalogue is complete", () => {
    const plan = writePlan(planEvidenceSave(req({ intendedSkillIds: [] })));
    assert.deepEqual(plan.skillIds, []);
  });

  it("never derives a replacement from an unavailable catalogue", () => {
    assert.deepEqual(planEvidenceSave(req({ intendedSkillIds: [], catalogue: unavailable })), {
      kind: "blocked",
      reason: "catalogue_unavailable",
    });
    const plan = writePlan(
      planEvidenceSave(req({ draft: edited({ title: "New title" }), intendedSkillIds: [], catalogue: unavailable }))
    );
    assert.equal(plan.content?.kind, "replace");
    assert.equal(plan.skillIds, null);
    assert.equal(plan.skillsBlocked, "catalogue_unavailable");
    assert.deepEqual(plan.intendedSkillIds, []);
  });

  it("blocks a set naming skills the catalogue does not contain", () => {
    assert.deepEqual(planEvidenceSave(req({ intendedSkillIds: [1, 99] })), { kind: "blocked", reason: "unknown_skills" });
  });

  it("plans a creation for a new source, links only when some are intended", () => {
    const draft: EvidenceDraft = { type: "cv", title: "CV 2026", description: "", url: "" };
    const bare = writePlan(planEvidenceSave(req({ saved: null, draft, intendedSkillIds: [] })));
    assert.deepEqual(bare.content, { kind: "create", input: { type: "cv", title: "CV 2026", description: null, url: null } });
    assert.equal(bare.skillIds, null);
    const linked = writePlan(planEvidenceSave(req({ saved: null, draft, intendedSkillIds: [2, 1] })));
    assert.equal(linked.content?.kind, "create");
    assert.deepEqual(linked.skillIds, [1, 2]);
    const offline = writePlan(planEvidenceSave(req({ saved: null, draft, intendedSkillIds: [], catalogue: unavailable })));
    assert.equal(offline.content?.kind, "create");
    assert.equal(offline.skillIds, null);
    assert.equal(offline.skillsBlocked, null);
  });

  it("reports an invalid draft without planning any write", () => {
    const plan = planEvidenceSave(req({ draft: edited({ title: " ", url: "ftp://x" }), intendedSkillIds: [2] }));
    assert.equal(plan.kind, "invalid");
    assert.ok(plan.kind === "invalid" && plan.fieldErrors.title && plan.fieldErrors.url);
  });
});

describe("afterContentStep", () => {
  const draft: EvidenceDraft = { type: "cv", title: "CV 2026", description: "", url: "" };
  const created: Evidence = { ...saved, id: 12, type: "cv", title: "CV 2026", description: null, url: null, reviewedAt: null, skillIds: [] };

  it("establishes the created source's id for the link request", () => {
    const plan = writePlan(planEvidenceSave(req({ saved: null, draft, intendedSkillIds: [2] })));
    assert.deepEqual(afterContentStep(plan, null, ok(created)), { kind: "send_skills", id: 12, skillIds: [2], source: created });
  });

  it("finishes a creation without links", () => {
    const plan = writePlan(planEvidenceSave(req({ saved: null, draft, intendedSkillIds: [] })));
    assert.deepEqual(afterContentStep(plan, null, ok(created)), { kind: "done", outcome: { kind: "saved", evidence: created } });
  });

  it("keeps an uncertain creation distinct from a rejection, with no id and the selection intact", () => {
    const plan = writePlan(planEvidenceSave(req({ saved: null, draft, intendedSkillIds: [2] })));
    for (const kind of ["network", "server", "unavailable", "invalid_response"] as const) {
      assert.deepEqual(afterContentStep(plan, null, fail({ kind })), {
        kind: "done",
        outcome: { kind: "content_uncertain", write: "create", failure: { kind }, evidence: null, pendingSkillIds: [2] },
      });
    }
    assert.deepEqual(afterContentStep(plan, null, fail({ kind: "too_large" })), {
      kind: "done",
      outcome: { kind: "rejected", step: "content", failure: { kind: "too_large" }, evidence: null, pendingSkillIds: [2] },
    });
  });

  it("identifies an uncertain replacement, keeping the confirmed version and the selection", () => {
    const plan = writePlan(planEvidenceSave(req({ draft: edited({ title: "X" }), intendedSkillIds: [2] })));
    assert.deepEqual(afterContentStep(plan, saved, fail({ kind: "network" })), {
      kind: "done",
      outcome: { kind: "content_uncertain", write: "replace", failure: { kind: "network" }, evidence: saved, pendingSkillIds: [2] },
    });
  });

  it("ends the save after an uncertain create or replace, with no further request", () => {
    const creation = writePlan(planEvidenceSave(req({ saved: null, draft, intendedSkillIds: [2] })));
    const replacement = writePlan(planEvidenceSave(req({ draft: edited({ title: "X" }), intendedSkillIds: [2] })));
    for (const [plan, before] of [
      [creation, null],
      [replacement, saved],
    ] as const) {
      const result = afterContentStep(plan, before, fail({ kind: "unavailable" }));
      // "done", not "send_skills": nothing is left to send, and the outcome
      // carries no request (no input, id or skill set to resend).
      assert.equal(result.kind, "done");
      assert.ok(result.kind === "done");
      assert.deepEqual(Object.keys(result.outcome).sort(), ["evidence", "failure", "kind", "pendingSkillIds", "write"]);
    }
  });

  it("does not send links after a rejected replacement and keeps the confirmed version", () => {
    const plan = writePlan(planEvidenceSave(req({ draft: edited({ title: "X" }), intendedSkillIds: [2] })));
    const result = afterContentStep(plan, saved, fail({ kind: "not_found" }));
    assert.deepEqual(result, {
      kind: "done",
      outcome: { kind: "rejected", step: "content", failure: { kind: "not_found" }, evidence: saved, pendingSkillIds: [2] },
    });
  });

  it("sends links after a confirmed replacement, against the confirmed source", () => {
    const plan = writePlan(planEvidenceSave(req({ draft: edited({ title: "X" }), intendedSkillIds: [] })));
    const replaced = { ...saved, title: "X", reviewedAt: null, updatedAt: "2026-10-22T09:00:00.000Z" };
    assert.deepEqual(afterContentStep(plan, saved, ok(replaced)), { kind: "send_skills", id: 4, skillIds: [], source: replaced });
  });

  it("skips the link write when the confirmed source already has the intended set", () => {
    const plan = writePlan(planEvidenceSave(req({ draft: edited({ title: "X" }), intendedSkillIds: [2] })));
    const replaced = { ...saved, title: "X", skillIds: [2] };
    assert.deepEqual(afterContentStep(plan, saved, ok(replaced)), { kind: "done", outcome: { kind: "saved", evidence: replaced } });
  });

  it("goes straight to the link write when there was no content write", () => {
    const plan = writePlan(planEvidenceSave(req({ intendedSkillIds: [1] })));
    assert.deepEqual(afterContentStep(plan, saved, null), { kind: "send_skills", id: 4, skillIds: [1], source: saved });
  });

  it("reports a confirmed content write with blocked links as partial, selection intact", () => {
    const plan = writePlan(
      planEvidenceSave(req({ draft: edited({ title: "X" }), intendedSkillIds: [2], catalogue: unavailable }))
    );
    const replaced = { ...saved, title: "X" };
    assert.deepEqual(afterContentStep(plan, saved, ok(replaced)), {
      kind: "done",
      outcome: {
        kind: "partial",
        evidence: replaced,
        skills: { kind: "blocked", reason: "catalogue_unavailable" },
        pendingSkillIds: [2],
      },
    });
  });
});

describe("afterSkillsStep", () => {
  const replaced = { ...saved, title: "X", reviewedAt: null };
  const linked = { ...replaced, skillIds: [2] };
  const both = writePlan(planEvidenceSave(req({ draft: edited({ title: "X" }), intendedSkillIds: [2] })));
  const linksOnly = writePlan(planEvidenceSave(req({ intendedSkillIds: [2] })));

  it("confirms the save with the link response", () => {
    assert.deepEqual(afterSkillsStep(both, replaced, ok(linked)), { kind: "saved", evidence: linked });
  });

  it("reports a rejected link write after confirmed content as partial", () => {
    const failure = { kind: "validation", details: [{ field: "skillIds[0]", message: "does not refer to an existing skill" }] } as const;
    assert.deepEqual(afterSkillsStep(both, replaced, fail(failure)), {
      kind: "partial",
      evidence: replaced,
      skills: { kind: "rejected", failure },
      pendingSkillIds: [2],
    });
  });

  it("reports a rejected association-only save as rejected, selection intact", () => {
    assert.deepEqual(afterSkillsStep(linksOnly, saved, fail({ kind: "not_found" })), {
      kind: "rejected",
      step: "skills",
      failure: { kind: "not_found" },
      evidence: saved,
      pendingSkillIds: [2],
    });
  });

  it("keeps an uncertain link write distinct from partial success", () => {
    for (const plan of [both, linksOnly]) {
      const source = plan === both ? replaced : saved;
      assert.deepEqual(afterSkillsStep(plan, source, fail({ kind: "network" })), {
        kind: "skills_uncertain",
        failure: { kind: "network" },
        evidence: source,
        pendingSkillIds: [2],
      });
    }
  });

  it("keeps an intended empty set pending after a failed unlink", () => {
    const plan = writePlan(planEvidenceSave(req({ intendedSkillIds: [] })));
    const outcome = afterSkillsStep(plan, saved, fail({ kind: "unavailable" }));
    assert.equal(outcome.kind, "skills_uncertain");
    assert.ok(outcome.kind === "skills_uncertain" && outcome.pendingSkillIds.length === 0);
    assert.deepEqual(outcome.evidence.skillIds, [1, 3]);
  });
});
