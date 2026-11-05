// State decisions for the evidence editor in EvidenceSection: how one save is
// run and what the editor knows afterwards. Pure apart from runEvidenceSave,
// which only sends the requests the Phase A helpers dictate. No React.
//
// The editor's draft and intended skill selection are owned by the section
// and are never changed here: these helpers only move the confirmed server
// version ("saved") and the recovery state, so no outcome can discard what
// the candidate typed or selected.

import {
  sameContent,
  sameSkillIds,
  toEvidenceDraft,
  validateEvidenceDraft,
  type Evidence,
  type EvidenceDraft,
} from "./evidence.ts";
import {
  createEvidence,
  replaceEvidence,
  replaceEvidenceSkills,
  type EvidenceApiFailure,
  type EvidenceApiResult,
} from "./evidenceApi.ts";
import {
  afterContentStep,
  afterSkillsStep,
  type EvidenceSaveOutcome,
  type SkillsBlockedReason,
  type WritePlan,
} from "./evidenceSave.ts";
import type { Skill } from "./skill.ts";

// A read of the source that tells the editor what the server holds after an
// uncertain or partial save. Reads are safe to run automatically; writes are
// never repeated without the candidate pressing Save.
export type CheckState = "checking" | "failed" | "done";

export type Recovery =
  // The POST may have created the source, but its id is unknown. Another
  // creation is blocked until the candidate picks an existing source or
  // explicitly chooses to create a new one.
  | { kind: "create_uncertain"; failure: EvidenceApiFailure }
  // The content PUT may or may not have been applied.
  | { kind: "content_uncertain"; failure: EvidenceApiFailure; check: CheckState }
  // The content (if changed) is confirmed; the link PUT may or may not have
  // been applied.
  | { kind: "links_uncertain"; failure: EvidenceApiFailure; check: CheckState }
  // The content is confirmed; the links were definitely not saved.
  | {
      kind: "links_not_saved";
      failure: EvidenceApiFailure | null;
      reason: SkillsBlockedReason | null;
      check: CheckState;
    }
  // The server answered 404 for this source.
  | { kind: "source_missing" };

export interface EvidenceEditor {
  // Last version the server confirmed for this editor; null while no
  // creation is confirmed. Every save is planned against it.
  saved: Evidence | null;
  recovery: Recovery | null;
}

// Values for a freshly opened editor. Only called on a deliberate open, never
// after a list refresh.
export function openEditor(evidence: Evidence | null): {
  editor: EvidenceEditor;
  draft: EvidenceDraft;
  intendedSkillIds: number[];
} {
  return {
    editor: { saved: evidence, recovery: null },
    draft: toEvidenceDraft(evidence),
    intendedSkillIds: evidence ? [...evidence.skillIds] : [],
  };
}

// Sends the writes of one plan in order: content, then (only after the
// content is confirmed) the complete link set. Each write is sent once.
// Throws only when the signal aborts, which does not undo a write the server
// already received.
export async function runEvidenceSave(
  plan: WritePlan,
  saved: Evidence | null,
  signal?: AbortSignal
): Promise<EvidenceSaveOutcome> {
  const content = plan.content;
  const result =
    content === null
      ? null
      : content.kind === "create"
        ? await createEvidence(content.input, signal)
        : await replaceEvidence(content.id, content.input, signal);
  const next = afterContentStep(plan, saved, result);
  if (next.kind === "done") return next.outcome;
  return afterSkillsStep(plan, next.source, await replaceEvidenceSkills(next.id, next.skillIds, signal));
}

// The editor after a save. A confirmed source (created or replaced) always
// becomes "saved", so a later Save never repeats a confirmed write and never
// creates the source again.
export function editorAfterSave(editor: EvidenceEditor, outcome: EvidenceSaveOutcome): EvidenceEditor {
  switch (outcome.kind) {
    case "saved":
      return { saved: outcome.evidence, recovery: null };
    case "rejected":
      if (outcome.failure.kind === "not_found" && outcome.evidence) {
        return { saved: outcome.evidence, recovery: { kind: "source_missing" } };
      }
      if (outcome.step === "skills") {
        return {
          saved: outcome.evidence,
          recovery: { kind: "links_not_saved", failure: outcome.failure, reason: null, check: "checking" },
        };
      }
      return { saved: editor.saved, recovery: null };
    case "content_uncertain":
      return outcome.write === "create"
        ? { saved: null, recovery: { kind: "create_uncertain", failure: outcome.failure } }
        : {
            saved: outcome.evidence,
            recovery: { kind: "content_uncertain", failure: outcome.failure, check: "checking" },
          };
    case "partial":
      return {
        saved: outcome.evidence,
        recovery:
          outcome.skills.kind === "rejected" && outcome.skills.failure.kind === "not_found"
            ? { kind: "source_missing" }
            : {
                kind: "links_not_saved",
                failure: outcome.skills.kind === "rejected" ? outcome.skills.failure : null,
                reason: outcome.skills.kind === "blocked" ? outcome.skills.reason : null,
                check: "checking",
              },
      };
    case "skills_uncertain":
      return {
        saved: outcome.evidence,
        recovery: { kind: "links_uncertain", failure: outcome.failure, check: "checking" },
      };
  }
}

type CheckedRecovery = Extract<Recovery, { check: CheckState }>;

export function hasCheck(recovery: Recovery | null): recovery is CheckedRecovery {
  return recovery !== null && "check" in recovery;
}

export function startCheck(editor: EvidenceEditor): EvidenceEditor {
  return hasCheck(editor.recovery) ? { ...editor, recovery: { ...editor.recovery, check: "checking" } } : editor;
}

// The editor after reading the source back. Success replaces the confirmed
// version (the draft is untouched); a failed read keeps the uncertainty.
export function editorAfterCheck(editor: EvidenceEditor, result: EvidenceApiResult<Evidence>): EvidenceEditor {
  if (!hasCheck(editor.recovery)) return editor;
  if (result.ok) return { saved: result.data, recovery: { ...editor.recovery, check: "done" } };
  if (result.failure.kind === "not_found") return { ...editor, recovery: { kind: "source_missing" } };
  return { ...editor, recovery: { ...editor.recovery, check: "failed" } };
}

// After an uncertain creation: continue with a source the candidate picked
// from the reloaded list. Its content and links become the confirmed version;
// the draft and selection stay as typed.
export function adoptExistingSource(editor: EvidenceEditor, evidence: Evidence): EvidenceEditor {
  return editor.recovery?.kind === "create_uncertain" ? { saved: evidence, recovery: null } : editor;
}

export const DUPLICATE_RISK_TEXT =
  "The previous creation request may already have succeeded. Creating another source could produce a duplicate.";

// The source the candidate picked in the reconciliation list, looked up by id
// in the current list only (never by title). Null when nothing is picked or
// the picked source is no longer listed, so a stale identity is never used.
export function adoptCandidate(evidence: readonly Evidence[], adoptId: string): Evidence | null {
  return adoptId === "" ? null : (evidence.find((e) => String(e.id) === adoptId) ?? null);
}

// What continuing with a picked source means for the next Save.
export function adoptConsequence(candidate: Evidence, draft: EvidenceDraft): string {
  if (draftMatches(draft, candidate)) {
    return "Its details already match your entries. Save will only set its skills to your selection, if they differ.";
  }
  return (
    "If you continue with this source, Save will replace its type, title, description and link with your entries " +
    "and set its skills to your selection." +
    (candidate.reviewedAt
      ? " It is candidate-reviewed: changing its details clears that review."
      : " Changing its details would clear any candidate review.")
  );
}

// After an uncertain creation, or for a source that no longer exists: the
// candidate explicitly asks for a new creation.
export function startNewCreation(editor: EvidenceEditor): EvidenceEditor {
  const kind = editor.recovery?.kind;
  return kind === "create_uncertain" || kind === "source_missing" ? { saved: null, recovery: null } : editor;
}

// Why Save is unavailable right now, or null when it may be pressed.
export function saveBlockedReason(editor: EvidenceEditor): string | null {
  const recovery = editor.recovery;
  if (!recovery) return null;
  switch (recovery.kind) {
    case "create_uncertain":
      return "Saving is paused until you choose how to continue, so the source is not added twice.";
    case "source_missing":
      return "This source no longer exists. Save your entries as a new source, or cancel.";
    default:
      if (recovery.check === "checking") return "Checking what the server holds…";
      if (recovery.check === "failed") return "Saving is paused until the server can be checked. Use “Check again”.";
      return null;
  }
}

// True when the draft would be stored exactly as the confirmed content.
export function draftMatches(draft: EvidenceDraft, evidence: Evidence): boolean {
  const validated = validateEvidenceDraft(draft);
  return validated.ok && sameContent(validated.normalized, evidence);
}

// True when saving the draft would clear the candidate's review: the source
// is reviewed and its content would change.
export function saveClearsReview(saved: Evidence | null, draft: EvidenceDraft): boolean {
  return saved !== null && saved.reviewedAt !== null && !draftMatches(draft, saved);
}

export function linksMatch(evidence: Evidence, intendedSkillIds: readonly number[]): boolean {
  return sameSkillIds(evidence.skillIds, intendedSkillIds);
}

// What a read-back of the source showed, shared by the recovery panel and the
// status line.
export const CHECK_TEXT = {
  contentMatches: "The server holds your changes.",
  contentDiffers: "The server holds a different version from your entries.",
  linksMatch: "The selected skills are linked now.",
  linksDiffer: "The skills linked on the server differ from your selection.",
  failed:
    "Could not check the server. It is still not known what was saved; your entries and skill selection are kept.",
  missing: "Checked: this evidence source no longer exists. Your entries and skill selection are kept.",
};

// The status line after a read-back: the outcome, not only that it ran.
// Content is compared only when its save was uncertain; otherwise it is
// confirmed and only the links are in question.
export function checkOutcomeStatus(
  editor: EvidenceEditor,
  draft: EvidenceDraft,
  intendedSkillIds: readonly number[]
): string {
  const recovery = editor.recovery;
  if (recovery?.kind === "source_missing") return CHECK_TEXT.missing;
  if (!hasCheck(recovery) || recovery.check === "checking") return "";
  if (recovery.check === "failed" || !editor.saved) return CHECK_TEXT.failed;
  const saved = editor.saved;
  const linksSame = linksMatch(saved, intendedSkillIds);
  if (recovery.kind === "content_uncertain") {
    const content = draftMatches(draft, saved) ? CHECK_TEXT.contentMatches : CHECK_TEXT.contentDiffers;
    return linksSame ? `Checked: ${content}` : `Checked: ${content} ${CHECK_TEXT.linksDiffer}`;
  }
  return `Checked: ${linksSame ? CHECK_TEXT.linksMatch : CHECK_TEXT.linksDiffer}`;
}

export const REVIEWED_LABEL = "Candidate-reviewed";
export const NOT_REVIEWED_LABEL = "Not yet candidate-reviewed";

export function reviewLabel(evidence: Evidence): string {
  return evidence.reviewedAt ? REVIEWED_LABEL : NOT_REVIEWED_LABEL;
}

// ── Skill names ─────────────────────────────────────────────────────────────

// Linked skills for display. The ids come from the source itself, so they
// are always known; only the names depend on the skill catalogue.
export type LinkedSkills =
  | { status: "names_unavailable"; count: number }
  | { status: "ready"; names: string[]; unknownIds: number[] };

export function linkedSkills(skillIds: readonly number[], skills: readonly Skill[] | null): LinkedSkills {
  if (!skills) return { status: "names_unavailable", count: skillIds.length };
  const byId = new Map(skills.map((s) => [s.id, s.name]));
  return {
    status: "ready",
    names: skills.filter((s) => skillIds.includes(s.id)).map((s) => s.name),
    unknownIds: skillIds.filter((id) => !byId.has(id)),
  };
}

export interface SkillChoice {
  id: number;
  name: string | null; // null: not in the loaded skill list
}

// Checkboxes for the editor: every catalogue skill in server order, then any
// id that is linked or selected but missing from the catalogue, so such links
// stay visible instead of silently disappearing.
export function skillChoices(skills: readonly Skill[], ...linkedIds: readonly (readonly number[])[]): SkillChoice[] {
  const known = new Set(skills.map((s) => s.id));
  const unknown = [...new Set(linkedIds.flat())].filter((id) => !known.has(id)).sort((a, b) => a - b);
  return [...skills.map((s) => ({ id: s.id, name: s.name })), ...unknown.map((id) => ({ id, name: null }))];
}
