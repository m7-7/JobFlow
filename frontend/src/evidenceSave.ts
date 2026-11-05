// Planning and reconciling one save of an evidence source: its content and
// its skill links. Pure functions, no React, no fetch; the caller sends the
// requests in the order these helpers dictate.
//
//  1. planEvidenceSave decides which writes are needed, from the confirmed
//     server version, the draft and the intended skill set.
//  2. If plan.content is set, send it (create or replace) and pass the result
//     to afterContentStep; otherwise call afterContentStep with null.
//  3. If that returns a skills request, send it and pass the result to
//     afterSkillsStep.
//
// Content is always written before links, because a new source has no id to
// link to until its creation is confirmed. Nothing is retried: an uncertain
// outcome is reported as such and the caller reconciles by reloading.

import {
  normalizeSkillIds,
  sameContent,
  sameSkillIds,
  validateEvidenceDraft,
  type Evidence,
  type EvidenceDraft,
  type EvidenceFieldErrors,
  type EvidenceInput,
} from "./evidence.ts";
import { writeOutcomeUnknown, type EvidenceApiFailure, type EvidenceApiResult } from "./evidenceApi.ts";

// The skills that can be linked. "complete" only once GET /api/skills has
// succeeded; while it is loading or after it failed the set is unknown, and
// no link replacement may be derived from it.
export type SkillCatalogue = { status: "complete"; skillIds: readonly number[] } | { status: "unavailable" };

export type ContentWrite = { kind: "create"; input: EvidenceInput } | { kind: "replace"; id: number; input: EvidenceInput };

// Why an intended change of links cannot be sent: the catalogue is not
// loaded, or the intended set names skills the catalogue does not contain.
export type SkillsBlockedReason = "catalogue_unavailable" | "unknown_skills";

export type EvidenceSavePlan =
  | { kind: "invalid"; fieldErrors: EvidenceFieldErrors }
  | { kind: "unchanged" }
  | { kind: "blocked"; reason: SkillsBlockedReason } // only the links changed, and they cannot be sent
  | {
      kind: "write";
      content: ContentWrite | null;
      // Complete replacement set to send, or null when no link write is sent.
      skillIds: number[] | null;
      skillsBlocked: SkillsBlockedReason | null;
      // The candidate's selection, kept whatever happens to the writes.
      intendedSkillIds: number[];
    };

export interface EvidenceSaveRequest {
  saved: Evidence | null; // confirmed server version; null for a new source
  draft: EvidenceDraft;
  intendedSkillIds: readonly number[];
  catalogue: SkillCatalogue;
}

export function planEvidenceSave({ saved, draft, intendedSkillIds, catalogue }: EvidenceSaveRequest): EvidenceSavePlan {
  const validated = validateEvidenceDraft(draft);
  if (!validated.ok) return { kind: "invalid", fieldErrors: validated.fieldErrors };

  const content: ContentWrite | null = !saved
    ? { kind: "create", input: validated.input }
    : sameContent(validated.normalized, saved)
      ? null
      : { kind: "replace", id: saved.id, input: validated.input };

  // A new source starts with no links.
  const intended = normalizeSkillIds(intendedSkillIds);
  const linksChanged = !sameSkillIds(intended, saved?.skillIds ?? []);
  let skillIds: number[] | null = null;
  let skillsBlocked: SkillsBlockedReason | null = null;
  if (linksChanged) {
    if (catalogue.status !== "complete") skillsBlocked = "catalogue_unavailable";
    else if (!intended.every((id) => catalogue.skillIds.includes(id))) skillsBlocked = "unknown_skills";
    else skillIds = intended;
  }

  if (!content && !skillIds) return skillsBlocked ? { kind: "blocked", reason: skillsBlocked } : { kind: "unchanged" };
  return { kind: "write", content, skillIds, skillsBlocked, intendedSkillIds: intended };
}

export type WritePlan = Extract<EvidenceSavePlan, { kind: "write" }>;

// The final state of one save. "evidence" is always the latest version the
// server confirmed (null only when a new source was never confirmed), and
// "pendingSkillIds" is the intended link set that is not yet confirmed, so
// a failure never discards the candidate's selection.
export type EvidenceSaveOutcome =
  // Every planned write was confirmed.
  | { kind: "saved"; evidence: Evidence }
  // The first write was definitely rejected: nothing was written.
  | {
      kind: "rejected";
      step: "content" | "skills";
      failure: EvidenceApiFailure;
      evidence: Evidence | null;
      pendingSkillIds: number[] | null;
    }
  // The content write may or may not have been committed. Links were not
  // sent. After an uncertain "create" the source may exist without the client
  // knowing its id, so the caller must reload rather than plan another
  // creation.
  | {
      kind: "content_uncertain";
      write: ContentWrite["kind"];
      failure: EvidenceApiFailure;
      evidence: Evidence | null;
      pendingSkillIds: number[] | null;
    }
  // The content was confirmed; the links were rejected or could not be sent.
  | {
      kind: "partial";
      evidence: Evidence;
      skills: { kind: "rejected"; failure: EvidenceApiFailure } | { kind: "blocked"; reason: SkillsBlockedReason };
      pendingSkillIds: number[] | null;
    }
  // Any content write was confirmed; the link write may or may not have been
  // committed.
  | { kind: "skills_uncertain"; failure: EvidenceApiFailure; evidence: Evidence; pendingSkillIds: number[] };

// The intended links not yet confirmed by the server, or null when the
// confirmed version (none for an unconfirmed new source) already has them.
function pendingLinks(plan: WritePlan, evidence: Evidence | null): number[] | null {
  return sameSkillIds(plan.intendedSkillIds, evidence?.skillIds ?? []) ? null : plan.intendedSkillIds;
}

export type AfterContent =
  | { kind: "send_skills"; id: number; skillIds: number[]; source: Evidence }
  | { kind: "done"; outcome: EvidenceSaveOutcome };

// After the content write (result null when the plan had none). Returns the
// link request to send next, with the confirmed source id, or the outcome.
export function afterContentStep(
  plan: WritePlan,
  saved: Evidence | null,
  result: EvidenceApiResult<Evidence> | null
): AfterContent {
  let source: Evidence;
  if (result === null) {
    // No content write was planned, so the source is the confirmed one.
    if (!saved) throw new Error("A new source must be created before its skills are linked.");
    source = saved;
  } else if (result.ok) {
    source = result.data;
  } else {
    const failure = result.failure;
    const pendingSkillIds = pendingLinks(plan, saved);
    if (!plan.content) throw new Error("A content result was given for a plan without a content write.");
    const write = plan.content.kind;
    const outcome: EvidenceSaveOutcome = writeOutcomeUnknown(failure)
      ? { kind: "content_uncertain", write, failure, evidence: saved, pendingSkillIds }
      : { kind: "rejected", step: "content", failure, evidence: saved, pendingSkillIds };
    return { kind: "done", outcome };
  }

  // The confirmed source may already carry the intended links (e.g. linked
  // in another tab); then there is nothing left to write.
  if (plan.skillIds && !sameSkillIds(plan.skillIds, source.skillIds)) {
    return { kind: "send_skills", id: source.id, skillIds: plan.skillIds, source };
  }
  if (plan.skillsBlocked) {
    const skills = { kind: "blocked", reason: plan.skillsBlocked } as const;
    return { kind: "done", outcome: { kind: "partial", evidence: source, skills, pendingSkillIds: pendingLinks(plan, source) } };
  }
  return { kind: "done", outcome: { kind: "saved", evidence: source } };
}

// After the link write. When this save also wrote the content, a rejected
// link write is a partial save rather than a rejection.
export function afterSkillsStep(
  plan: WritePlan,
  source: Evidence,
  result: EvidenceApiResult<Evidence>
): EvidenceSaveOutcome {
  if (result.ok) return { kind: "saved", evidence: result.data };
  const failure = result.failure;
  const pendingSkillIds = plan.intendedSkillIds;
  if (writeOutcomeUnknown(failure)) return { kind: "skills_uncertain", failure, evidence: source, pendingSkillIds };
  if (plan.content) return { kind: "partial", evidence: source, skills: { kind: "rejected", failure }, pendingSkillIds };
  return { kind: "rejected", step: "skills", failure, evidence: source, pendingSkillIds };
}
