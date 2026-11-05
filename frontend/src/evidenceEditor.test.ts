// Editor state decisions and the save sequence against a stubbed fetch (no
// server, no React, no dependencies).
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { toEvidenceDraft, type Evidence, type EvidenceDraft } from "./evidence.ts";
import {
  CHECK_TEXT,
  DUPLICATE_RISK_TEXT,
  checkOutcomeStatus,
  adoptCandidate,
  adoptConsequence,
  adoptExistingSource,
  draftMatches,
  editorAfterCheck,
  editorAfterSave,
  linkedSkills,
  linksMatch,
  openEditor,
  reviewLabel,
  runEvidenceSave,
  saveBlockedReason,
  saveClearsReview,
  skillChoices,
  startCheck,
  startNewCreation,
  type EvidenceEditor,
} from "./evidenceEditor.ts";
import { planEvidenceSave, type EvidenceSavePlan, type EvidenceSaveRequest, type WritePlan } from "./evidenceSave.ts";
import type { Skill } from "./skill.ts";

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
const newDraft: EvidenceDraft = { type: "cv", title: "CV 2026", description: "", url: "" };
const created: Evidence = {
  ...saved,
  id: 12,
  type: "cv",
  title: "CV 2026",
  description: null,
  url: null,
  reviewedAt: null,
  skillIds: [],
};

const skill = (id: number, name: string): Skill => ({
  id,
  name,
  experienceContexts: [],
  practicalConfidence: null,
  interviewConfidence: null,
  experienceMonths: null,
  lastUsedYear: null,
  notes: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});
const skills = [skill(3, "Go"), skill(1, "PostgreSQL"), skill(2, "TypeScript")];

const req = (overrides: Partial<EvidenceSaveRequest> = {}): EvidenceSaveRequest => ({
  saved,
  draft: toEvidenceDraft(saved),
  intendedSkillIds: saved.skillIds,
  catalogue: { status: "complete", skillIds: [1, 2, 3] },
  ...overrides,
});
const edited = (overrides: Partial<EvidenceDraft>) => ({ ...toEvidenceDraft(saved), ...overrides });

function writePlan(plan: EvidenceSavePlan): WritePlan {
  assert.equal(plan.kind, "write");
  return plan as WritePlan;
}

// ── Stubbed fetch ───────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];

// Answers each request in turn from the given responders.
function stubFetch(...responders: (() => Response | Promise<Response>)[]) {
  calls = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method ?? "GET", url, body: init.body ? JSON.parse(init.body as string) : undefined });
    const respond = responders[calls.length - 1];
    if (!respond) throw new Error(`unexpected request ${init.method} ${url}`);
    return respond();
  }) as typeof fetch;
}

const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const offline = () => Promise.reject(new TypeError("Failed to fetch"));
const requests = () => calls.map((c) => `${c.method} ${c.url}`);

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── runEvidenceSave ─────────────────────────────────────────────────────────

describe("runEvidenceSave request sequence", () => {
  it("creates a source without links with one POST and no skills PUT", async () => {
    const plan = writePlan(planEvidenceSave(req({ saved: null, draft: newDraft, intendedSkillIds: [] })));
    stubFetch(json(201, created));
    const outcome = await runEvidenceSave(plan, null);
    assert.deepEqual(requests(), ["POST /api/evidence"]);
    assert.deepEqual(outcome, { kind: "saved", evidence: created });
  });

  it("creates, adopts the confirmed id, then PUTs the complete intended set", async () => {
    const plan = writePlan(planEvidenceSave(req({ saved: null, draft: newDraft, intendedSkillIds: [3, 1] })));
    const linked = { ...created, skillIds: [1, 3] };
    stubFetch(json(201, created), json(200, linked));
    const outcome = await runEvidenceSave(plan, null);
    assert.deepEqual(requests(), ["POST /api/evidence", "PUT /api/evidence/12/skills"]);
    assert.deepEqual(calls[1].body, { skillIds: [1, 3] });
    assert.deepEqual(outcome, { kind: "saved", evidence: linked });
  });

  it("sends only the content PUT for a content-only change", async () => {
    const plan = writePlan(planEvidenceSave(req({ draft: edited({ title: "Senior engineer" }) })));
    const replaced = { ...saved, title: "Senior engineer", reviewedAt: null };
    stubFetch(json(200, replaced));
    assert.deepEqual(await runEvidenceSave(plan, saved), { kind: "saved", evidence: replaced });
    assert.deepEqual(requests(), ["PUT /api/evidence/4"]);
    assert.deepEqual(Object.keys(calls[0].body as object), ["type", "title", "description", "url"]);
  });

  it("sends only the skills PUT for a links-only change, including an intentional []", async () => {
    const plan = writePlan(planEvidenceSave(req({ intendedSkillIds: [] })));
    stubFetch(json(200, { ...saved, skillIds: [] }));
    await runEvidenceSave(plan, saved);
    assert.deepEqual(requests(), ["PUT /api/evidence/4/skills"]);
    assert.deepEqual(calls[0].body, { skillIds: [] });
  });

  it("sends content first and links only after it is confirmed", async () => {
    const plan = writePlan(planEvidenceSave(req({ draft: edited({ url: "" }), intendedSkillIds: [2] })));
    const replaced = { ...saved, url: null, reviewedAt: null, updatedAt: "2026-10-22T09:00:00.000Z" };
    stubFetch(json(200, replaced), json(200, { ...replaced, skillIds: [2] }));
    await runEvidenceSave(plan, saved);
    assert.deepEqual(requests(), ["PUT /api/evidence/4", "PUT /api/evidence/4/skills"]);

    stubFetch(json(400, { error: "validation_error", details: [{ field: "url", message: "must be…" }] }));
    const rejected = await runEvidenceSave(plan, saved);
    assert.deepEqual(requests(), ["PUT /api/evidence/4"]);
    assert.equal(rejected.kind, "rejected");
  });

  it("never sends links after an uncertain POST", async () => {
    const plan = writePlan(planEvidenceSave(req({ saved: null, draft: newDraft, intendedSkillIds: [2] })));
    stubFetch(offline);
    const outcome = await runEvidenceSave(plan, null);
    assert.deepEqual(requests(), ["POST /api/evidence"]);
    assert.equal(outcome.kind, "content_uncertain");
  });

  it("sends nothing more after a failed links PUT", async () => {
    const plan = writePlan(planEvidenceSave(req({ draft: edited({ title: "X" }), intendedSkillIds: [2] })));
    stubFetch(json(200, { ...saved, title: "X" }), json(503, { error: "database_unavailable" }));
    const outcome = await runEvidenceSave(plan, saved);
    assert.equal(calls.length, 2);
    assert.equal(outcome.kind, "skills_uncertain");
  });

  it("issues no request with a catalogue-blocked content save beyond the content PUT", async () => {
    const plan = writePlan(
      planEvidenceSave(
        req({ draft: edited({ title: "X" }), intendedSkillIds: [2], catalogue: { status: "unavailable" } })
      )
    );
    stubFetch(json(200, { ...saved, title: "X" }));
    const outcome = await runEvidenceSave(plan, saved);
    assert.deepEqual(requests(), ["PUT /api/evidence/4"]);
    assert.equal(outcome.kind, "partial");
  });

  it("rethrows an abort instead of reporting an outcome", async () => {
    const plan = writePlan(planEvidenceSave(req({ draft: edited({ title: "X" }) })));
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })) as typeof fetch;
    const controller = new AbortController();
    const pending = runEvidenceSave(plan, saved, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
  });
});

// ── Editor state after a save ───────────────────────────────────────────────

describe("editorAfterSave", () => {
  const editing: EvidenceEditor = { saved, recovery: null };
  const creating: EvidenceEditor = { saved: null, recovery: null };

  it("adopts the confirmed source, so the next save is never another creation", () => {
    const next = editorAfterSave(creating, { kind: "saved", evidence: created });
    assert.deepEqual(next, { saved: created, recovery: null });
    const plan = planEvidenceSave(req({ saved: next.saved, draft: newDraft, intendedSkillIds: [] }));
    assert.deepEqual(plan, { kind: "unchanged" });
  });

  it("keeps the created id after a partial save and plans only the links next", () => {
    const failure = { kind: "validation", details: [{ field: "skillIds[0]", message: "does not refer…" }] } as const;
    const next = editorAfterSave(creating, {
      kind: "partial",
      evidence: created,
      skills: { kind: "rejected", failure },
      pendingSkillIds: [2],
    });
    assert.equal(next.saved?.id, 12);
    assert.deepEqual(next.recovery, { kind: "links_not_saved", failure, reason: null, check: "checking" });
    const plan = writePlan(planEvidenceSave(req({ saved: next.saved, draft: newDraft, intendedSkillIds: [2] })));
    assert.equal(plan.content, null);
    assert.deepEqual(plan.skillIds, [2]);
  });

  it("blocks creation after an uncertain POST, without a source", () => {
    const next = editorAfterSave(creating, {
      kind: "content_uncertain",
      write: "create",
      failure: { kind: "network" },
      evidence: null,
      pendingSkillIds: [2],
    });
    assert.deepEqual(next, { saved: null, recovery: { kind: "create_uncertain", failure: { kind: "network" } } });
    assert.ok(saveBlockedReason(next));
  });

  it("keeps the confirmed version after an uncertain PUT and requires a check", () => {
    const next = editorAfterSave(editing, {
      kind: "content_uncertain",
      write: "replace",
      failure: { kind: "server" },
      evidence: saved,
      pendingSkillIds: null,
    });
    assert.deepEqual(next, {
      saved,
      recovery: { kind: "content_uncertain", failure: { kind: "server" }, check: "checking" },
    });
    assert.ok(saveBlockedReason(next));
  });

  it("adopts the confirmed content after an uncertain links PUT", () => {
    const replaced = { ...saved, title: "X", reviewedAt: null };
    const next = editorAfterSave(editing, {
      kind: "skills_uncertain",
      failure: { kind: "network" },
      evidence: replaced,
      pendingSkillIds: [2],
    });
    assert.equal(next.saved, replaced);
    assert.equal(next.recovery?.kind, "links_uncertain");
  });

  it("reports blocked links after a confirmed content save", () => {
    const replaced = { ...saved, title: "X" };
    const next = editorAfterSave(editing, {
      kind: "partial",
      evidence: replaced,
      skills: { kind: "blocked", reason: "catalogue_unavailable" },
      pendingSkillIds: [2],
    });
    assert.deepEqual(next, {
      saved: replaced,
      recovery: { kind: "links_not_saved", failure: null, reason: "catalogue_unavailable", check: "checking" },
    });
  });

  it("marks the source missing on a 404 for content or links", () => {
    assert.deepEqual(
      editorAfterSave(editing, {
        kind: "rejected",
        step: "content",
        failure: { kind: "not_found" },
        evidence: saved,
        pendingSkillIds: null,
      }).recovery,
      { kind: "source_missing" }
    );
    assert.deepEqual(
      editorAfterSave(editing, {
        kind: "partial",
        evidence: saved,
        skills: { kind: "rejected", failure: { kind: "not_found" } },
        pendingSkillIds: [2],
      }).recovery,
      { kind: "source_missing" }
    );
  });

  it("keeps the confirmed version and no recovery on a definite content rejection", () => {
    assert.deepEqual(
      editorAfterSave(editing, {
        kind: "rejected",
        step: "content",
        failure: { kind: "too_large" },
        evidence: saved,
        pendingSkillIds: null,
      }),
      { saved, recovery: null }
    );
  });
});

// ── Reconciliation ──────────────────────────────────────────────────────────

describe("reconciliation after an uncertain save", () => {
  const uncertainLinks: EvidenceEditor = {
    saved,
    recovery: { kind: "links_uncertain", failure: { kind: "network" }, check: "checking" },
  };

  it("adopts the server version and reports whether the intended links are present", () => {
    const persisted = { ...saved, skillIds: [2] };
    const next = editorAfterCheck(uncertainLinks, { ok: true, data: persisted });
    assert.deepEqual(next, { saved: persisted, recovery: { ...uncertainLinks.recovery!, check: "done" } });
    assert.equal(saveBlockedReason(next), null);
    assert.equal(linksMatch(persisted, [2]), true);
    assert.equal(linksMatch(saved, [2]), false);
  });

  it("plans only the remaining links once the server state is known", () => {
    const next = editorAfterCheck(uncertainLinks, { ok: true, data: saved });
    const plan = writePlan(planEvidenceSave(req({ saved: next.saved, intendedSkillIds: [2] })));
    assert.equal(plan.content, null);
    assert.deepEqual(plan.skillIds, [2]);
    const done = editorAfterCheck(uncertainLinks, { ok: true, data: { ...saved, skillIds: [2] } });
    assert.deepEqual(planEvidenceSave(req({ saved: done.saved, intendedSkillIds: [2] })), { kind: "unchanged" });
  });

  it("does not repeat a content PUT that the check shows was applied", () => {
    const draft = edited({ title: "Senior engineer" });
    const uncertain: EvidenceEditor = {
      saved,
      recovery: { kind: "content_uncertain", failure: { kind: "server" }, check: "checking" },
    };
    const applied = { ...saved, title: "Senior engineer", reviewedAt: null };
    const next = editorAfterCheck(uncertain, { ok: true, data: applied });
    assert.equal(draftMatches(draft, next.saved!), true);
    assert.deepEqual(planEvidenceSave(req({ saved: next.saved, draft })), { kind: "unchanged" });
  });

  it("keeps the uncertainty and the confirmed version when the check fails", () => {
    for (const kind of ["network", "unavailable", "server", "invalid_response"] as const) {
      const next = editorAfterCheck(uncertainLinks, { ok: false, failure: { kind } });
      assert.deepEqual(next, { saved, recovery: { ...uncertainLinks.recovery!, check: "failed" } });
      assert.ok(saveBlockedReason(next));
    }
  });

  it("can check again after a failed check", () => {
    const failed = editorAfterCheck(uncertainLinks, { ok: false, failure: { kind: "network" } });
    assert.deepEqual(startCheck(failed).recovery, { ...uncertainLinks.recovery!, check: "checking" });
  });

  it("turns a 404 during the check into a missing source", () => {
    assert.deepEqual(editorAfterCheck(uncertainLinks, { ok: false, failure: { kind: "not_found" } }).recovery, {
      kind: "source_missing",
    });
  });

  it("ignores a check result when no check is pending", () => {
    const plain: EvidenceEditor = { saved, recovery: null };
    assert.equal(editorAfterCheck(plain, { ok: true, data: created }), plain);
  });
});

describe("resolving an uncertain creation", () => {
  const uncertain: EvidenceEditor = {
    saved: null,
    recovery: { kind: "create_uncertain", failure: { kind: "network" } },
  };

  it("continues with the source the candidate picked, so the next save is a PUT", () => {
    const next = adoptExistingSource(uncertain, created);
    assert.deepEqual(next, { saved: created, recovery: null });
    const plan = writePlan(
      planEvidenceSave(req({ saved: next.saved, draft: { ...newDraft, url: "https://x.test/" } }))
    );
    assert.equal(plan.content?.kind, "replace");
  });

  it("allows a new creation only on an explicit request", () => {
    assert.ok(saveBlockedReason(uncertain));
    const next = startNewCreation(uncertain);
    assert.deepEqual(next, { saved: null, recovery: null });
    assert.equal(saveBlockedReason(next), null);
    assert.equal(writePlan(planEvidenceSave(req({ saved: next.saved, draft: newDraft }))).content?.kind, "create");
  });

  it("does not adopt or restart outside that state", () => {
    const editing: EvidenceEditor = { saved, recovery: null };
    assert.equal(adoptExistingSource(editing, created), editing);
    assert.equal(startNewCreation(editing), editing);
    assert.deepEqual(startNewCreation({ saved, recovery: { kind: "source_missing" } }), {
      saved: null,
      recovery: null,
    });
  });
});

// ── Draft and display helpers ───────────────────────────────────────────────

describe("openEditor", () => {
  it("starts a new source empty, with no links", () => {
    assert.deepEqual(openEditor(null), {
      editor: { saved: null, recovery: null },
      draft: { type: "professional_experience", title: "", description: "", url: "" },
      intendedSkillIds: [],
    });
  });

  it("starts an edit from the chosen source, copying its links", () => {
    const opened = openEditor(saved);
    assert.equal(opened.editor.saved, saved);
    assert.deepEqual(opened.draft, toEvidenceDraft(saved));
    assert.deepEqual(opened.intendedSkillIds, [1, 3]);
    assert.notEqual(opened.intendedSkillIds, saved.skillIds);
  });

  it("is the only source of draft values: state changes never alter a draft", () => {
    const draft = edited({ title: "Typed but unsaved" });
    const selection = [2];
    const copy = { draft: { ...draft }, selection: [...selection] };
    const editor: EvidenceEditor = { saved, recovery: null };
    editorAfterSave(editor, {
      kind: "skills_uncertain",
      failure: { kind: "network" },
      evidence: saved,
      pendingSkillIds: selection,
    });
    editorAfterCheck(editor, { ok: true, data: created });
    assert.deepEqual({ draft, selection }, copy);
  });
});

describe("saveClearsReview", () => {
  it("is true only for a reviewed source whose content would change", () => {
    assert.equal(saveClearsReview(saved, edited({ title: "X" })), true);
    assert.equal(saveClearsReview(saved, edited({ title: "  Backend engineer at Acme " })), false);
    assert.equal(saveClearsReview({ ...saved, reviewedAt: null }, edited({ title: "X" })), false);
    assert.equal(saveClearsReview(null, newDraft), false);
  });
});

describe("reviewLabel", () => {
  it("uses the candidate-review wording", () => {
    assert.equal(reviewLabel(saved), "Candidate-reviewed");
    assert.equal(reviewLabel({ ...saved, reviewedAt: null }), "Not yet candidate-reviewed");
  });
});

describe("linkedSkills", () => {
  it("names linked skills in catalogue order and keeps ids missing from it", () => {
    assert.deepEqual(linkedSkills([1, 3, 99], skills), {
      status: "ready",
      names: ["Go", "PostgreSQL"],
      unknownIds: [99],
    });
  });

  it("reports the known count, not an empty set, when names are unavailable", () => {
    assert.deepEqual(linkedSkills([1, 3], null), { status: "names_unavailable", count: 2 });
    assert.deepEqual(linkedSkills([], null), { status: "names_unavailable", count: 0 });
  });
});

describe("skillChoices", () => {
  it("lists the catalogue, then linked or selected ids missing from it", () => {
    assert.deepEqual(skillChoices(skills, [1, 99], [42, 1]), [
      { id: 3, name: "Go" },
      { id: 1, name: "PostgreSQL" },
      { id: 2, name: "TypeScript" },
      { id: 42, name: null },
      { id: 99, name: null },
    ]);
  });

  it("keeps every linked id visible when the catalogue is not loaded", () => {
    assert.deepEqual(skillChoices([], [1, 3]), [
      { id: 1, name: null },
      { id: 3, name: null },
    ]);
  });

  it("an unknown linked id blocks a link change instead of being dropped", () => {
    const withDeleted = { ...saved, skillIds: [1, 99] };
    const plan = planEvidenceSave(req({ saved: withDeleted, intendedSkillIds: [1, 2, 99] }));
    assert.deepEqual(plan, { kind: "blocked", reason: "unknown_skills" });
    // Unticking it is an explicit choice, and then the full set is sent.
    const unticked = writePlan(planEvidenceSave(req({ saved: withDeleted, intendedSkillIds: [1, 2] })));
    assert.deepEqual(unticked.skillIds, [1, 2]);
  });
});

describe("previewing a source before continuing with it", () => {
  const list = [saved, created, { ...created, id: 13 }]; // 12 and 13 share a title
  const draft = edited({ title: "Typed after the uncertain POST" });

  it("finds nothing until a source is picked, and never matches by title", () => {
    assert.equal(adoptCandidate(list, ""), null);
    assert.equal(adoptCandidate(list, "CV 2026"), null);
    assert.equal(adoptCandidate(list, "13")?.id, 13);
  });

  it("requires a new choice when the picked source is no longer listed", () => {
    assert.equal(adoptCandidate([saved], "12"), null);
  });

  it("previews server values without adopting, and keeps the draft and selection", () => {
    const editor: EvidenceEditor = {
      saved: null,
      recovery: { kind: "create_uncertain", failure: { kind: "network" } },
    };
    const selection = [2];
    const copy = { draft: { ...draft }, selection: [...selection] };
    const candidate = adoptCandidate(list, "4");
    assert.deepEqual(candidate, saved);
    assert.equal(saveBlockedReason(editor) !== null, true); // previewing is not adopting
    const adopted = adoptExistingSource(editor, candidate!);
    assert.deepEqual(adopted, { saved, recovery: null });
    assert.deepEqual({ draft, selection }, copy);
    // The next Save replaces the picked source; it is not a new creation.
    const plan = writePlan(planEvidenceSave(req({ saved: adopted.saved, draft, intendedSkillIds: selection })));
    assert.equal(plan.content?.kind, "replace");
  });

  it("explains that Save would replace the picked source and clear its review", () => {
    const text = adoptConsequence(saved, draft);
    assert.match(text, /replace its type, title, description and link with your entries/);
    assert.match(text, /candidate-reviewed: changing its details clears that review/);
    assert.match(adoptConsequence(created, draft), /would clear any candidate review/);
  });

  it("says only the skills may change when the details already match", () => {
    assert.match(adoptConsequence(saved, toEvidenceDraft(saved)), /already match your entries/);
  });

  it("states the duplicate risk explicitly", () => {
    assert.equal(
      DUPLICATE_RISK_TEXT,
      "The previous creation request may already have succeeded. Creating another source could produce a duplicate."
    );
  });
});

describe("status line after a read-back", () => {
  const draftOf = (e: Evidence) => toEvidenceDraft(e);
  const checked = (kind: "content_uncertain" | "links_uncertain" | "links_not_saved", server: Evidence) =>
    editorAfterCheck(
      kind === "links_not_saved"
        ? { saved, recovery: { kind, failure: null, reason: null, check: "checking" } }
        : { saved, recovery: { kind, failure: { kind: "network" }, check: "checking" } },
      { ok: true, data: server }
    );

  it("says the server holds the submitted content, or a different version", () => {
    const server = { ...saved, title: "Typed" };
    assert.equal(
      checkOutcomeStatus(checked("content_uncertain", server), draftOf(server), server.skillIds),
      `Checked: ${CHECK_TEXT.contentMatches}`
    );
    assert.equal(
      checkOutcomeStatus(checked("content_uncertain", saved), edited({ title: "Typed" }), saved.skillIds),
      `Checked: ${CHECK_TEXT.contentDiffers}`
    );
  });

  it("adds that the links differ after an uncertain content save with a pending selection", () => {
    assert.equal(
      checkOutcomeStatus(checked("content_uncertain", saved), draftOf(saved), [2]),
      `Checked: ${CHECK_TEXT.contentMatches} ${CHECK_TEXT.linksDiffer}`
    );
  });

  it("says whether the selected skills are linked after an uncertain or failed links save", () => {
    const linked = { ...saved, skillIds: [2] };
    for (const kind of ["links_uncertain", "links_not_saved"] as const) {
      assert.equal(checkOutcomeStatus(checked(kind, linked), draftOf(saved), [2]), `Checked: ${CHECK_TEXT.linksMatch}`);
      assert.equal(checkOutcomeStatus(checked(kind, saved), draftOf(saved), [2]), `Checked: ${CHECK_TEXT.linksDiffer}`);
    }
  });

  it("keeps the uncertainty when the read-back failed", () => {
    const editor = editorAfterCheck(
      { saved, recovery: { kind: "content_uncertain", failure: { kind: "network" }, check: "checking" } },
      { ok: false, failure: { kind: "network" } }
    );
    assert.equal(checkOutcomeStatus(editor, draftOf(saved), saved.skillIds), CHECK_TEXT.failed);
    assert.match(CHECK_TEXT.failed, /still not known what was saved/);
  });

  it("reports a missing source", () => {
    const editor = editorAfterCheck(
      { saved, recovery: { kind: "links_uncertain", failure: { kind: "network" }, check: "checking" } },
      { ok: false, failure: { kind: "not_found" } }
    );
    assert.equal(checkOutcomeStatus(editor, draftOf(saved), [2]), CHECK_TEXT.missing);
  });
});
