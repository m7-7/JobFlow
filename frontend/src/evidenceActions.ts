// Candidate review and deletion of one evidence source, as used by the
// review and delete panels in EvidenceSection. Pure apart from the two
// confirm functions, which send exactly one request each. No React.
//
// A review attests only to the persisted content the candidate inspected:
// the panel reads the source from the server first, and the confirmation
// sends that version's exact updatedAt. Nothing here reads or changes an
// editor draft or the skill links. Writes are never repeated automatically:
// after an uncertain outcome the source is read back and the candidate
// decides what to do next.

import type { Evidence } from "./evidence.ts";
import {
  deleteEvidence,
  reviewEvidence,
  writeOutcomeUnknown,
  type EvidenceApiFailure,
  type EvidenceApiResult,
} from "./evidenceApi.ts";

export const REVIEW_SCOPE_TEXT =
  "Candidate review confirms that you have inspected this source's details. It does not independently verify the evidence or its linked skills.";

export type CheckState = "checking" | "failed";

// ── Review ──────────────────────────────────────────────────────────────────

// Why the shown version is not the one first opened, if it is not.
//  stale:        the server answered 409; the source changed after it was read.
//  changed:      after an uncertain review the source holds other content.
//  not_recorded: after an uncertain review the server holds no review of it.
export type ReviewNotice = "stale" | "changed" | "not_recorded";

export type ReviewPhase =
  // Reading the persisted source; nothing can be confirmed.
  | { kind: "loading" }
  | { kind: "load_failed"; failure: EvidenceApiFailure }
  // The persisted version the candidate inspects and may confirm.
  | { kind: "ready"; inspected: Evidence; error: EvidenceApiFailure | null }
  // The review POST may or may not have been recorded.
  | { kind: "uncertain"; inspected: Evidence; failure: EvidenceApiFailure; check: CheckState }
  // The server holds a review of the inspected version.
  | { kind: "reviewed"; evidence: Evidence; via: "confirmed" | "reconciled" }
  | { kind: "missing" };

export interface ReviewPanel {
  kind: "review";
  id: number;
  title: string; // from the list until the source is read
  notice: ReviewNotice | null;
  phase: ReviewPhase;
}

export function openReview(evidence: Evidence): ReviewPanel {
  return { kind: "review", id: evidence.id, title: evidence.title, notice: null, phase: { kind: "loading" } };
}

// The confirmation is possible only for a version read from the server.
export function reviewInspected(panel: ReviewPanel): Evidence | null {
  return panel.phase.kind === "ready" ? panel.phase.inspected : null;
}

// Sends the one review request for the inspected version, with its exact
// updatedAt. Throws only when the signal aborts.
export function confirmReview(inspected: Evidence, signal?: AbortSignal): Promise<EvidenceApiResult<Evidence>> {
  return reviewEvidence(inspected.id, inspected.updatedAt, signal);
}

function afterLoad(panel: ReviewPanel, result: EvidenceApiResult<Evidence>): ReviewPanel {
  if (result.ok) {
    return { ...panel, title: result.data.title, phase: { kind: "ready", inspected: result.data, error: null } };
  }
  if (result.failure.kind === "not_found") return { ...panel, phase: { kind: "missing" } };
  return { ...panel, phase: { kind: "load_failed", failure: result.failure } };
}

export function reviewAfterConfirm(
  panel: ReviewPanel,
  inspected: Evidence,
  result: EvidenceApiResult<Evidence>
): ReviewPanel {
  if (result.ok) return { ...panel, phase: { kind: "reviewed", evidence: result.data, via: "confirmed" } };
  const failure = result.failure;
  // The inspected content is outdated: drop it and read the current one,
  // which has to be inspected and confirmed again.
  if (failure.kind === "stale") return { ...panel, notice: "stale", phase: { kind: "loading" } };
  if (failure.kind === "not_found") return { ...panel, phase: { kind: "missing" } };
  if (writeOutcomeUnknown(failure)) {
    return { ...panel, phase: { kind: "uncertain", inspected, failure, check: "checking" } };
  }
  return { ...panel, phase: { kind: "ready", inspected, error: failure } };
}

// After reading the source back following an uncertain review. A content
// change always clears reviewedAt on the server, so a set reviewedAt on the
// unchanged version means that version is reviewed (possibly by an earlier
// review). Which of reviewedAt and updatedAt is later says nothing.
function afterReviewCheck(
  panel: ReviewPanel,
  phase: Extract<ReviewPhase, { kind: "uncertain" }>,
  result: EvidenceApiResult<Evidence>
): ReviewPanel {
  if (!result.ok) {
    if (result.failure.kind === "not_found") return { ...panel, phase: { kind: "missing" } };
    return { ...panel, phase: { ...phase, check: "failed" } };
  }
  const current = result.data;
  if (current.updatedAt !== phase.inspected.updatedAt) {
    return {
      ...panel,
      title: current.title,
      notice: "changed",
      phase: { kind: "ready", inspected: current, error: null },
    };
  }
  if (current.reviewedAt !== null) {
    return { ...panel, phase: { kind: "reviewed", evidence: current, via: "reconciled" } };
  }
  return { ...panel, notice: "not_recorded", phase: { kind: "ready", inspected: current, error: null } };
}

// ── Delete ──────────────────────────────────────────────────────────────────

export type DeletePhase =
  // Waiting for the candidate's explicit confirmation. stillExists: a check
  // after an uncertain delete found the source (shown as "evidence").
  | { kind: "confirm"; error: EvidenceApiFailure | null; stillExists: boolean }
  | { kind: "uncertain"; failure: EvidenceApiFailure; check: CheckState }
  // The server confirmed this delete.
  | { kind: "deleted" }
  // The source does not exist; this does not say whether this delete removed it.
  | { kind: "absent" };

export interface DeletePanel {
  kind: "delete";
  id: number;
  evidence: Evidence; // the version identified in the confirmation
  phase: DeletePhase;
}

export function openDelete(evidence: Evidence): DeletePanel {
  return { kind: "delete", id: evidence.id, evidence, phase: { kind: "confirm", error: null, stillExists: false } };
}

// Sends the one delete request. Throws only when the signal aborts.
export function confirmDelete(panel: DeletePanel, signal?: AbortSignal): Promise<EvidenceApiResult<void>> {
  return deleteEvidence(panel.id, signal);
}

export function deleteAfterConfirm(panel: DeletePanel, result: EvidenceApiResult<void>): DeletePanel {
  if (result.ok) return { ...panel, phase: { kind: "deleted" } };
  const failure = result.failure;
  if (failure.kind === "not_found") return { ...panel, phase: { kind: "absent" } };
  if (writeOutcomeUnknown(failure)) return { ...panel, phase: { kind: "uncertain", failure, check: "checking" } };
  return {
    ...panel,
    phase: { kind: "confirm", error: failure, stillExists: panel.phase.kind === "confirm" && panel.phase.stillExists },
  };
}

function afterDeleteCheck(
  panel: DeletePanel,
  phase: Extract<DeletePhase, { kind: "uncertain" }>,
  result: EvidenceApiResult<Evidence>
): DeletePanel {
  if (result.ok) return { ...panel, evidence: result.data, phase: { kind: "confirm", error: null, stillExists: true } };
  if (result.failure.kind === "not_found") return { ...panel, phase: { kind: "absent" } };
  return { ...panel, phase: { ...phase, check: "failed" } };
}

// ── Shared ──────────────────────────────────────────────────────────────────

export type ActionPanel = ReviewPanel | DeletePanel;

// True while the panel waits for a GET of its source: the first read of a
// review, the reread after a 409, or a check after an uncertain write.
export function panelNeedsRead(panel: ActionPanel): boolean {
  const phase = panel.phase;
  return phase.kind === "loading" || (phase.kind === "uncertain" && phase.check === "checking");
}

// Starts another read after a failed one ("Try again" / "Check again").
export function retryPanelRead(panel: ActionPanel): ActionPanel {
  if (panel.kind === "review") {
    const phase = panel.phase;
    if (phase.kind === "load_failed") return { ...panel, phase: { kind: "loading" } };
    if (phase.kind === "uncertain" && phase.check === "failed")
      return { ...panel, phase: { ...phase, check: "checking" } };
    return panel;
  }
  const phase = panel.phase;
  if (phase.kind === "uncertain" && phase.check === "failed")
    return { ...panel, phase: { ...phase, check: "checking" } };
  return panel;
}

// The panel after a GET of its source. A read the panel no longer waits for
// changes nothing.
export function panelAfterRead(panel: ActionPanel, result: EvidenceApiResult<Evidence>): ActionPanel {
  if (!panelNeedsRead(panel)) return panel;
  if (panel.kind === "review") {
    const phase = panel.phase;
    return phase.kind === "uncertain" ? afterReviewCheck(panel, phase, result) : afterLoad(panel, result);
  }
  const phase = panel.phase;
  return phase.kind === "uncertain" ? afterDeleteCheck(panel, phase, result) : panel;
}

// Where focus goes once a source has left the list: the next surviving
// source, else the previous one; null when none remains.
export function neighborAfterRemoval(evidence: readonly Evidence[], removedId: number): number | null {
  const index = evidence.findIndex((e) => e.id === removedId);
  if (index === -1) return evidence[0]?.id ?? null;
  return evidence[index + 1]?.id ?? evidence[index - 1]?.id ?? null;
}

// True when an open panel's source is missing from a freshly loaded list and
// no review or delete write of that panel is running (its own outcome decides
// then). Such a panel has no row to show it, so it is closed.
export function panelOrphaned(
  panel: ActionPanel | null,
  evidence: readonly Evidence[],
  panelWriting: boolean
): panel is ActionPanel {
  return panel !== null && !panelWriting && !evidence.some((e) => e.id === panel.id);
}
