import { useEffect, useRef, useState } from "react";
import EvidenceForm, { evidenceFieldId } from "./EvidenceForm.tsx";
import { styles as formStyles } from "./SkillForm.tsx";
import {
  REVIEW_SCOPE_TEXT,
  confirmDelete,
  confirmReview,
  deleteAfterConfirm,
  neighborAfterRemoval,
  openDelete,
  openReview,
  panelAfterRead,
  panelNeedsRead,
  panelOrphaned,
  retryPanelRead,
  reviewAfterConfirm,
  reviewInspected,
  type ActionPanel,
  type DeletePanel,
  type ReviewPanel,
} from "./evidenceActions.ts";
import {
  EVIDENCE_DRAFT_FIELDS,
  SOURCE_TYPE_LABELS,
  groupEvidenceFieldErrors,
  toggleSkillId,
  type Evidence,
  type EvidenceDraft,
  type EvidenceDraftField,
  type EvidenceFieldErrors,
} from "./evidence.ts";
import { fetchEvidence, fetchEvidenceList, type EvidenceApiFailure, type EvidenceApiResult } from "./evidenceApi.ts";
import { planEvidenceSave, type SkillCatalogue, type SkillsBlockedReason } from "./evidenceSave.ts";
import {
  CHECK_TEXT,
  DUPLICATE_RISK_TEXT,
  NOT_REVIEWED_LABEL,
  adoptCandidate,
  adoptConsequence,
  adoptExistingSource,
  checkOutcomeStatus,
  draftMatches,
  editorAfterCheck,
  editorAfterSave,
  hasCheck,
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
  type CheckState,
  type EvidenceEditor,
  type Recovery,
} from "./evidenceEditor.ts";
import type { Skill } from "./skill.ts";
import { fetchSkills, type SkillApiResult } from "./skillsApi.ts";

// "My evidence": the candidate's evidence sources (jobs, projects, CVs,
// portfolios) and the skills each one supports. Lists them in server order
// and lets the user add, edit, candidate-review and delete them.
//
// A save may need two writes: the source content, then the complete set of
// linked skills. Mutations are pessimistic and never retried automatically.
// When an outcome is uncertain (network failure, 5xx, unexpected response)
// the source is read back and the candidate decides what to do next; the
// draft and the skill selection are kept throughout. Background reloads of
// the list or the skill catalogue never touch an open draft.
//
// Review and delete run in a panel under the source's row, which can be open
// next to the editor. Only one write (save, review or delete) runs at a time.

type ListState =
  | { status: "loading" }
  | { status: "ready"; evidence: Evidence[] }
  | { status: "error"; message: string };

// The complete skill catalogue. On a failed reload the previously loaded one
// is kept.
type CatalogueState =
  | { status: "loading" }
  | { status: "ready"; skills: Skill[] }
  | { status: "error"; message: string };

interface OpenEditor extends EvidenceEditor {
  key: number; // identifies this editor for responses that arrive late
  returnFocusId: string;
}

type LoadOutcome = { kind: "ok"; evidence: Evidence[] } | { kind: "failed"; message: string } | { kind: "superseded" };

type Notice = { message: string; retry: boolean };

// The open review or delete panel; key identifies it for late responses.
type OpenPanel = ActionPanel & { key: number; returnFocusId: string };

const HEADING_ID = "evidence-heading";
const ADD_BUTTON_ID = "evidence-add";
const SUBMIT_ID = "evidence-submit";
const RECOVERY_ID = "evidence-recovery";
const ADOPT_SELECT_ID = "evidence-adopt-source";
const PANEL_HEADING_ID = "evidence-panel-heading";
const PANEL_CANCEL_ID = "evidence-panel-cancel";
const PANEL_CONFIRM_ID = "evidence-panel-confirm";
const editButtonId = (id: number) => `evidence-${id}-edit`;
const reviewButtonId = (id: number) => `evidence-${id}-review`;
const deleteButtonId = (id: number) => `evidence-${id}-delete`;

function failureMessage(failure: EvidenceApiFailure): string {
  switch (failure.kind) {
    case "validation":
    case "bad_request":
      return "The request was rejected because some values are invalid.";
    case "not_found":
      return "That evidence source no longer exists.";
    case "stale":
      return "The evidence source changed in the meantime.";
    case "too_large":
      return "The evidence source is too large to save. Please shorten the description.";
    case "unavailable":
      return "The database is currently unavailable.";
    case "network":
      return "Could not reach the JobFlow server.";
    case "invalid_response":
      return "The server sent an unexpected response.";
    case "server":
      return "Something went wrong on the server.";
  }
}

const BLOCKED_LINKS_MESSAGE: Record<SkillsBlockedReason, string> = {
  catalogue_unavailable: "the skill list is not loaded, so the links could not be checked",
  unknown_skills: "some selected skills are not in your loaded skill list",
};

const UNKNOWN_SKILLS_ERROR =
  "Some selected skills are not in your loaded skill list; they may have been deleted. Reload skills, or untick them, before saving the links.";

const RECOVERY_STATUS: Record<Recovery["kind"], string> = {
  create_uncertain: "Not confirmed whether the evidence was added.",
  content_uncertain: "Not confirmed whether your changes were saved.",
  links_uncertain: "Source saved; not confirmed whether the skill links were saved.",
  links_not_saved: "Source saved; skill links not saved.",
  source_missing: "Evidence not saved: the source no longer exists.",
};

const formatDate = (iso: string) => new Date(iso).toLocaleString();

export default function EvidenceSection() {
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [catalogue, setCatalogue] = useState<CatalogueState>({ status: "loading" });
  const [editor, setEditor] = useState<OpenEditor | null>(null);
  const [draft, setDraft] = useState<EvidenceDraft>(() => openEditor(null).draft);
  const [intendedSkillIds, setIntendedSkillIds] = useState<number[]>([]);
  const [fieldErrors, setFieldErrors] = useState<EvidenceFieldErrors>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [adoptId, setAdoptId] = useState("");
  const [status, setStatus] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [panel, setPanel] = useState<OpenPanel | null>(null);
  const [panelBusy, setPanelBusy] = useState(false); // review or delete in flight

  // Synchronous single-mutation guard: state updates are not visible to a
  // second click fired before React re-renders.
  const mutatingRef = useRef(false);
  const mutationAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  // The open editor's key; responses for an editor that has since closed or
  // been replaced are ignored.
  const editorKeyRef = useRef(0);
  // Only the newest request of each kind may update state; older ones are
  // aborted and their responses ignored.
  const loadSeqRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const loadPromiseRef = useRef<Promise<LoadOutcome> | null>(null);
  const catalogueSeqRef = useRef(0);
  const catalogueAbortRef = useRef<AbortController | null>(null);
  const checkSeqRef = useRef(0);
  const checkAbortRef = useRef<AbortController | null>(null);
  const pendingFocusRef = useRef<string[] | null>(null);
  // The open panel, current between renders, so a response is applied to the
  // panel it belongs to.
  const panelRef = useRef<OpenPanel | null>(null);
  const panelKeyRef = useRef(0);
  const panelReadSeqRef = useRef(0);
  const panelAbortRef = useRef<AbortController | null>(null);
  // True while the open panel's own review or delete write runs.
  const panelWriteRef = useRef(false);
  // The editor, draft and selection as last rendered, for describing a
  // read-back that completes later.
  const latestRef = useRef({ editor, draft, intendedSkillIds });
  latestRef.current = { editor, draft, intendedSkillIds };

  useEffect(() => {
    mountedRef.current = true;
    void loadList();
    void loadCatalogue();
    return () => {
      mountedRef.current = false;
      loadAbortRef.current?.abort();
      catalogueAbortRef.current?.abort();
      checkAbortRef.current?.abort();
      panelAbortRef.current?.abort();
      // Only stops waiting: a write the server already received may still
      // be committed. Nothing is shown after unmount anyway.
      mutationAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const ids = pendingFocusRef.current;
    if (!ids) return;
    pendingFocusRef.current = null;
    const target = [...ids, HEADING_ID]
      .map((id) => document.getElementById(id))
      .find((el) => el !== null && !(el as HTMLButtonElement).disabled);
    target?.focus();
  });

  function focusAfterRender(...ids: string[]) {
    pendingFocusRef.current = ids;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  function loadList(): Promise<LoadOutcome> {
    const promise = runLoad();
    loadPromiseRef.current = promise;
    return promise;
  }

  async function runLoad(): Promise<LoadOutcome> {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const seq = ++loadSeqRef.current;
    setRefreshing(true);

    let result: EvidenceApiResult<Evidence[]>;
    try {
      result = await fetchEvidenceList(controller.signal);
    } catch {
      // Aborted: superseded by a newer load or unmounted.
      return { kind: "superseded" };
    }
    if (!mountedRef.current) return { kind: "superseded" };
    if (seq !== loadSeqRef.current) return loadPromiseRef.current ?? { kind: "superseded" };

    loadAbortRef.current = null;
    setRefreshing(false);
    if (result.ok) {
      setList({ status: "ready", evidence: result.data });
      closeOrphanedPanel(result.data);
      return { kind: "ok", evidence: result.data };
    }
    const message = failureMessage(result.failure);
    setList((current) => (current.status === "ready" ? current : { status: "error", message }));
    return { kind: "failed", message };
  }

  async function loadCatalogue(): Promise<void> {
    catalogueAbortRef.current?.abort();
    const controller = new AbortController();
    catalogueAbortRef.current = controller;
    const seq = ++catalogueSeqRef.current;
    let result: SkillApiResult<Skill[]>;
    try {
      result = await fetchSkills(controller.signal);
    } catch {
      return;
    }
    if (!mountedRef.current || seq !== catalogueSeqRef.current) return;
    catalogueAbortRef.current = null;
    if (result.ok) {
      setCatalogue({ status: "ready", skills: result.data });
    } else {
      const message =
        result.failure.kind === "network" ? "Could not reach the JobFlow server." : "The server could not provide it.";
      setCatalogue((current) => (current.status === "ready" ? current : { status: "error", message }));
    }
  }

  // Reads the source back after an uncertain or partial save. The skill list
  // is reloaded at the same time so the links can be compared by name.
  async function checkSource(key: number, id: number) {
    checkAbortRef.current?.abort();
    const controller = new AbortController();
    checkAbortRef.current = controller;
    const seq = ++checkSeqRef.current;
    setEditor((current) => (current && current.key === key ? { ...current, ...startCheck(current) } : current));
    void loadCatalogue();

    let result: EvidenceApiResult<Evidence>;
    try {
      result = await fetchEvidence(id, controller.signal);
    } catch {
      return; // aborted: a newer check, closed editor or unmount
    }
    if (!mountedRef.current || seq !== checkSeqRef.current || editorKeyRef.current !== key) return;
    checkAbortRef.current = null;
    setEditor((current) =>
      current && current.key === key ? { ...current, ...editorAfterCheck(current, result) } : current
    );
    const latest = latestRef.current;
    if (latest.editor && latest.editor.key === key) {
      setStatus(checkOutcomeStatus(editorAfterCheck(latest.editor, result), latest.draft, latest.intendedSkillIds));
    }
    focusAfterRender(RECOVERY_ID);
  }

  async function handleRefresh() {
    if (mutatingRef.current) return;
    setNotice(null);
    if (list.status === "error") setList({ status: "loading" });
    setStatus("Loading evidence…");
    void loadCatalogue();
    const outcome = await loadList();
    if (!mountedRef.current) return;
    if (outcome.kind === "ok") setStatus("Evidence list refreshed.");
    else if (outcome.kind === "failed") {
      setStatus("");
      if (list.status === "ready")
        setNotice({ message: `Could not refresh the evidence list. ${outcome.message}`, retry: true });
    }
  }

  // Only the newest successful list load gets here. A panel whose source it
  // no longer contains has no row to show it (or its Cancel), so it is closed;
  // its pending read is ignored. An open editor is left as it is.
  function closeOrphanedPanel(evidence: readonly Evidence[]) {
    const current = panelRef.current;
    if (!panelOrphaned(current, evidence, panelWriteRef.current)) return;
    panelReadSeqRef.current++;
    panelAbortRef.current?.abort();
    updatePanel(null);
    const title = current.kind === "delete" ? current.evidence.title : current.title;
    setNotice({
      message: `“${title}” is no longer in your evidence list, so its ${current.kind} panel was closed.`,
      retry: false,
    });
    // A save in flight moves focus itself when it ends.
    if (!mutatingRef.current) focusAfterRender(ADD_BUTTON_ID);
  }

  // ── Editor ────────────────────────────────────────────────────────────────

  function open(evidence: Evidence | null, returnFocusId: string) {
    if (mutatingRef.current || editor || panelRef.current?.kind === "delete") return;
    const opened = openEditor(evidence);
    setEditor({ ...opened.editor, key: ++editorKeyRef.current, returnFocusId });
    setDraft(opened.draft);
    setIntendedSkillIds(opened.intendedSkillIds);
    setFieldErrors({});
    setGeneralError(null);
    setAdoptId("");
    setStatus("");
    // Skills may have been added since the page loaded.
    void loadCatalogue();
    focusAfterRender(evidenceFieldId("title"));
  }

  // Deliberate close: never writes. Late responses for this editor are
  // ignored from now on.
  function closeEditor() {
    if (mutatingRef.current || !editor) return;
    editorKeyRef.current++;
    checkAbortRef.current?.abort();
    focusAfterRender(editor.returnFocusId, ADD_BUTTON_ID);
    setEditor(null);
    setFieldErrors({});
    setGeneralError(null);
    setStatus("");
  }

  function updateField<F extends EvidenceDraftField>(field: F, value: EvidenceDraft[F]) {
    setDraft((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  function toggleSkill(id: number, checked: boolean) {
    setIntendedSkillIds((current) => toggleSkillId(current, id, checked));
    setFieldErrors((current) => {
      if (!current.skillIds) return current;
      const next = { ...current };
      delete next.skillIds;
      return next;
    });
  }

  function retryCheck() {
    if (!editor?.saved || mutatingRef.current) return;
    void checkSource(editor.key, editor.saved.id);
  }

  function adoptSelected() {
    if (!editor || mutatingRef.current || list.status !== "ready") return;
    const chosen = adoptCandidate(list.evidence, adoptId);
    if (!chosen) return;
    setEditor({ ...editor, ...adoptExistingSource(editor, chosen) });
    setGeneralError(null);
    setStatus(`Continuing with “${chosen.title}”. Your entries are kept; Save applies them to this source.`);
    focusAfterRender(SUBMIT_ID);
  }

  function createAnew() {
    if (!editor || mutatingRef.current) return;
    setEditor({ ...editor, ...startNewCreation(editor) });
    setGeneralError(null);
    setStatus("Your entries are kept. Save them to add a new evidence source.");
    focusAfterRender(SUBMIT_ID);
  }

  const catalogueForPlan: SkillCatalogue =
    catalogue.status === "ready"
      ? { status: "complete", skillIds: catalogue.skills.map((s) => s.id) }
      : { status: "unavailable" };

  async function handleSubmit() {
    if (!editor || mutatingRef.current) return;
    const target = editor;
    if (saveBlockedReason(target)) return;

    const plan = planEvidenceSave({ saved: target.saved, draft, intendedSkillIds, catalogue: catalogueForPlan });
    if (plan.kind === "invalid") {
      setFieldErrors(plan.fieldErrors);
      setGeneralError(null);
      setStatus("Evidence not saved. Please correct the fields marked below.");
      const first = EVIDENCE_DRAFT_FIELDS.find((field) => plan.fieldErrors[field]);
      focusAfterRender(first ? evidenceFieldId(first) : SUBMIT_ID);
      return;
    }
    if (plan.kind === "unchanged") {
      setFieldErrors({});
      setGeneralError(null);
      setStatus("Nothing to save: the source and its skills already match what the server holds.");
      return;
    }
    // Unknown selected skills: write nothing rather than save half of it.
    if (
      (plan.kind === "blocked" && plan.reason === "unknown_skills") ||
      (plan.kind === "write" && plan.skillsBlocked === "unknown_skills")
    ) {
      setFieldErrors({ skillIds: [UNKNOWN_SKILLS_ERROR] });
      setGeneralError(null);
      setStatus("Evidence not saved.");
      focusAfterRender(evidenceFieldId("skillIds"));
      return;
    }
    if (plan.kind === "blocked") {
      setFieldErrors({ skillIds: [`The links cannot be saved now: ${BLOCKED_LINKS_MESSAGE[plan.reason]}.`] });
      setStatus("Evidence not saved.");
      focusAfterRender(evidenceFieldId("skillIds"));
      return;
    }

    mutatingRef.current = true;
    // A read of this source started before the save must not overwrite what
    // the save confirms.
    checkSeqRef.current++;
    checkAbortRef.current?.abort();
    const controller = new AbortController();
    mutationAbortRef.current = controller;
    setSaving(true);
    setFieldErrors({});
    setGeneralError(null);
    setNotice(null);
    setStatus(plan.content?.kind === "create" ? "Adding evidence…" : "Saving…");

    try {
      let outcome;
      try {
        outcome = await runEvidenceSave(plan, target.saved, controller.signal);
      } catch (err) {
        if (controller.signal.aborted) return; // unmounted
        throw err;
      }
      if (!mountedRef.current) return;

      const next: OpenEditor = { ...target, ...editorAfterSave(target, outcome) };
      const listReload = loadList();

      if (outcome.kind === "saved") {
        // Confirmed. Close once the list shows the saved source.
        const loaded = await listReload;
        if (!mountedRef.current) return;
        editorKeyRef.current++;
        setEditor(null);
        setStatus(`Evidence “${outcome.evidence.title}” ${target.saved ? "saved" : "added"}.`);
        if (loaded.kind === "failed") {
          setNotice({
            message: "Your change was saved, but the evidence list could not be reloaded, so it may be out of date.",
            retry: true,
          });
        }
        focusAfterRender(editButtonId(outcome.evidence.id), ADD_BUTTON_ID);
        return;
      }

      setEditor(next);
      if (outcome.kind === "rejected" && next.recovery === null) {
        // Definite rejection of the content: nothing was written.
        setStatus("Evidence not saved.");
        if (outcome.failure.kind === "validation") {
          const grouped = groupEvidenceFieldErrors(outcome.failure.details);
          setFieldErrors(grouped.fieldErrors);
          setGeneralError(
            grouped.general.length > 0
              ? grouped.general.join(" ")
              : "Some values are invalid. Please correct the fields marked above."
          );
          const first = EVIDENCE_DRAFT_FIELDS.find((field) => grouped.fieldErrors[field]);
          focusAfterRender(first ? evidenceFieldId(first) : SUBMIT_ID);
        } else {
          setGeneralError(failureMessage(outcome.failure));
          focusAfterRender(SUBMIT_ID);
        }
        return;
      }

      if (next.recovery?.kind === "links_not_saved" && next.recovery.failure?.kind === "validation") {
        setFieldErrors(groupEvidenceFieldErrors(next.recovery.failure.details).fieldErrors);
      }
      setStatus(next.recovery ? RECOVERY_STATUS[next.recovery.kind] : "Evidence not saved.");
      if (hasCheck(next.recovery) && next.saved) void checkSource(next.key, next.saved.id);
      focusAfterRender(RECOVERY_ID);
    } finally {
      mutatingRef.current = false;
      mutationAbortRef.current = null;
      if (mountedRef.current) setSaving(false);
    }
  }

  // ── Review and delete panels ──────────────────────────────────────────────

  function updatePanel(next: OpenPanel | null) {
    panelRef.current = next;
    setPanel(next);
  }

  const withMeta = (current: OpenPanel, next: ActionPanel): OpenPanel => ({
    ...next,
    key: current.key,
    returnFocusId: current.returnFocusId,
  });

  function openPanel(next: ActionPanel, returnFocusId: string, focusId: string) {
    if (mutatingRef.current) return;
    panelReadSeqRef.current++;
    panelAbortRef.current?.abort();
    const opened = { ...next, key: ++panelKeyRef.current, returnFocusId } as OpenPanel;
    updatePanel(opened);
    setStatus(opened.kind === "review" ? `Loading the saved details of “${opened.title}” for review…` : "");
    if (panelNeedsRead(opened)) void readPanelSource(opened.key, opened.id);
    focusAfterRender(focusId);
  }

  // Deliberate close: never writes. Late responses for it are ignored.
  function closePanel() {
    const current = panelRef.current;
    if (mutatingRef.current || !current) return;
    panelReadSeqRef.current++;
    panelAbortRef.current?.abort();
    updatePanel(null);
    setStatus("");
    focusAfterRender(current.returnFocusId, ADD_BUTTON_ID);
  }

  // Reads the panel's source: the version to review, or the state after an
  // uncertain review or delete.
  async function readPanelSource(key: number, id: number) {
    panelAbortRef.current?.abort();
    const controller = new AbortController();
    panelAbortRef.current = controller;
    const seq = ++panelReadSeqRef.current;
    let result: EvidenceApiResult<Evidence>;
    try {
      result = await fetchEvidence(id, controller.signal);
    } catch {
      return; // aborted: a newer read, a write, a closed panel or unmount
    }
    const current = panelRef.current;
    if (!mountedRef.current || seq !== panelReadSeqRef.current || !current || current.key !== key) return;
    panelAbortRef.current = null;
    applyPanel(current, withMeta(current, panelAfterRead(current, result)));
  }

  function retryPanel() {
    const current = panelRef.current;
    if (!current || mutatingRef.current) return;
    applyPanel(current, withMeta(current, retryPanelRead(current)));
  }

  // Shows a panel transition, or closes the panel once the source is
  // reviewed or gone.
  function applyPanel(prev: OpenPanel, next: OpenPanel) {
    const phase = next.phase;
    if (next.kind === "review" && phase.kind === "reviewed") {
      const reviewed = phase.evidence;
      setList((current) =>
        current.status === "ready"
          ? { status: "ready", evidence: current.evidence.map((e) => (e.id === reviewed.id ? reviewed : e)) }
          : current
      );
      void loadList();
      // Same content, new review state; an editor with its own recovery keeps it.
      setEditor((current) =>
        current && current.recovery === null && current.saved?.id === reviewed.id
          ? { ...current, saved: reviewed }
          : current
      );
      updatePanel(null);
      setStatus(
        phase.via === "confirmed"
          ? `“${reviewed.title}” is now candidate-reviewed.`
          : `The server shows the version of “${reviewed.title}” you inspected as candidate-reviewed.`
      );
      focusAfterRender(next.returnFocusId, ADD_BUTTON_ID);
      return;
    }
    if (phase.kind === "missing" || phase.kind === "deleted" || phase.kind === "absent") {
      const title = next.kind === "delete" ? next.evidence.title : next.title;
      const neighbor = list.status === "ready" ? neighborAfterRemoval(list.evidence, next.id) : null;
      setList((current) =>
        current.status === "ready"
          ? { status: "ready", evidence: current.evidence.filter((e) => e.id !== next.id) }
          : current
      );
      void loadList();
      setEditor((current) =>
        current && current.saved?.id === next.id ? { ...current, recovery: { kind: "source_missing" } } : current
      );
      updatePanel(null);
      setStatus(
        phase.kind === "deleted"
          ? `Evidence “${title}” deleted. Its skill links were removed; your skills are unchanged.`
          : prev.phase.kind === "uncertain"
            ? `“${title}” is no longer present. It is not known whether your delete request removed it.`
            : `“${title}” no longer exists.`
      );
      focusAfterRender(...(neighbor === null ? [] : [editButtonId(neighbor), reviewButtonId(neighbor)]), ADD_BUTTON_ID);
      return;
    }
    updatePanel(next);
    if (panelNeedsRead(next)) void readPanelSource(next.key, next.id);
    setStatus(panelStatus(next));
    focusAfterRender(PANEL_HEADING_ID);
  }

  function panelStatus(next: OpenPanel): string {
    const phase = next.phase;
    if (next.kind === "review") {
      switch (phase.kind) {
        case "loading":
          return next.notice === "stale"
            ? `“${next.title}” changed after you opened it. Loading its current details…`
            : `Loading the saved details of “${next.title}” for review…`;
        case "load_failed":
          return "Could not load the saved details. The review cannot be confirmed.";
        case "ready":
          if (phase.error) return "Review not recorded.";
          if (next.notice === "stale") return "Review not recorded: the source changed. Check its current details.";
          if (next.notice === "changed") return "The source has changed. Check its current details.";
          if (next.notice === "not_recorded") return "The server holds no review of this version.";
          return `Saved details of “${next.title}” loaded for review.`;
        case "uncertain":
          return phase.check === "checking"
            ? "Not confirmed whether your review was recorded. Checking…"
            : "Could not check the server.";
        default:
          return "";
      }
    }
    switch (phase.kind) {
      case "confirm":
        return phase.error
          ? "Evidence not deleted."
          : phase.stillExists
            ? `“${next.evidence.title}” still exists.`
            : "";
      case "uncertain":
        return phase.check === "checking"
          ? `Not confirmed whether “${next.evidence.title}” was deleted. Checking…`
          : "Could not check the server.";
      default:
        return "";
    }
  }

  async function runPanelWrite<T>(
    send: (signal: AbortSignal) => Promise<T>,
    decide: (current: OpenPanel, result: T) => ActionPanel,
    pending: string
  ) {
    const current = panelRef.current;
    if (!current || mutatingRef.current) return;
    mutatingRef.current = true;
    panelWriteRef.current = true;
    // A read started before the write must not overwrite what it confirms.
    panelReadSeqRef.current++;
    panelAbortRef.current?.abort();
    const controller = new AbortController();
    mutationAbortRef.current = controller;
    setPanelBusy(true);
    setNotice(null);
    setStatus(pending);
    try {
      let result: T;
      try {
        result = await send(controller.signal);
      } catch (err) {
        if (controller.signal.aborted) return; // unmounted
        throw err;
      }
      const latest = panelRef.current;
      // The panel cannot be closed or replaced while the write runs.
      if (!mountedRef.current || !latest || latest.key !== current.key) return;
      applyPanel(latest, withMeta(latest, decide(latest, result)));
    } finally {
      mutatingRef.current = false;
      panelWriteRef.current = false;
      mutationAbortRef.current = null;
      if (mountedRef.current) setPanelBusy(false);
    }
  }

  function confirmReviewAction() {
    const current = panelRef.current;
    const inspected = current?.kind === "review" ? reviewInspected(current) : null;
    if (!inspected) return;
    // Exactly the version shown; a newer one is never substituted.
    void runPanelWrite(
      (signal) => confirmReview(inspected, signal),
      (latest, result) => reviewAfterConfirm(latest as ReviewPanel, inspected, result),
      `Recording your review of “${inspected.title}”…`
    );
  }

  function confirmDeleteAction() {
    const current = panelRef.current;
    if (current?.kind !== "delete" || current.phase.kind !== "confirm") return;
    void runPanelWrite(
      (signal) => confirmDelete(current, signal),
      (latest, result) => deleteAfterConfirm(latest as DeletePanel, result),
      `Deleting “${current.evidence.title}”…`
    );
  }

  function handlePanelKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closePanel();
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  const heading = (
    <h2 id={HEADING_ID} tabIndex={-1} style={styles.cardTitle}>
      My evidence
    </h2>
  );

  if (list.status === "loading") {
    return (
      <section style={styles.card} aria-labelledby={HEADING_ID} aria-busy="true">
        {heading}
        <p role="status">Loading evidence…</p>
      </section>
    );
  }

  if (list.status === "error") {
    return (
      <section style={styles.card} aria-labelledby={HEADING_ID}>
        {heading}
        <p role="alert" style={formStyles.errorText}>
          Could not load your evidence. {list.message} Please try again.
        </p>
        <button type="button" onClick={handleRefresh} style={formStyles.button}>
          Try again
        </button>
      </section>
    );
  }

  const evidence = list.evidence;
  const skills = catalogue.status === "ready" ? catalogue.skills : null;
  const busy = saving || panelBusy;
  const rowActionsDisabled = busy || editor !== null || panel?.kind === "delete";

  function skillNames(ids: readonly number[]): string {
    const linked = linkedSkills(ids, skills);
    if (linked.status === "names_unavailable") {
      return linked.count === 0
        ? "No linked skills"
        : `${linked.count} linked ${linked.count === 1 ? "skill" : "skills"} (names unavailable)`;
    }
    const parts = [...linked.names, ...linked.unknownIds.map((id) => `Skill #${id} (not in your loaded skill list)`)];
    return parts.length === 0 ? "No linked skills" : parts.join(", ");
  }

  function contentRows(saved: Evidence) {
    return (
      <>
        <dt style={styles.dt}>Type</dt>
        <dd style={styles.dd}>{SOURCE_TYPE_LABELS[saved.type]}</dd>
        <dt style={styles.dt}>Title</dt>
        <dd style={styles.dd}>{saved.title}</dd>
        <dt style={styles.dt}>Description</dt>
        <dd style={{ ...styles.dd, whiteSpace: "pre-wrap" }}>{saved.description ?? "—"}</dd>
        <dt style={styles.dt}>Link</dt>
        <dd style={styles.dd}>{saved.url ?? "—"}</dd>
      </>
    );
  }

  function serverVersion(saved: Evidence) {
    return (
      <dl style={styles.serverVersion}>
        {contentRows(saved)}
        <dt style={styles.dt}>Skills</dt>
        <dd style={styles.dd}>{skillNames(saved.skillIds)}</dd>
      </dl>
    );
  }

  // The persisted content a review covers, with its exact version.
  function reviewDetails(inspected: Evidence) {
    return (
      <dl style={styles.serverVersion} aria-label="Saved details being reviewed">
        {contentRows(inspected)}
        <dt style={styles.dt}>Content version</dt>
        <dd style={styles.dd}>
          Last changed <time dateTime={inspected.updatedAt}>{formatDate(inspected.updatedAt)}</time> (
          {inspected.updatedAt})
        </dd>
        <dt style={styles.dt}>Current status</dt>
        <dd style={styles.dd}>{reviewLabel(inspected)}</dd>
      </dl>
    );
  }

  function panelButtons(
    confirm: { label: string; pending: string; enabled: boolean; danger?: boolean; onClick: () => void } | null
  ) {
    return (
      <div style={styles.itemActions}>
        {confirm && (
          <button
            id={PANEL_CONFIRM_ID}
            type="button"
            onClick={confirm.onClick}
            disabled={busy || !confirm.enabled}
            style={{
              ...styles.smallButton,
              ...(confirm.danger ? styles.danger : {}),
              ...(panelBusy ? formStyles.buttonBusy : off(busy || !confirm.enabled)),
            }}
          >
            {panelBusy ? confirm.pending : confirm.label}
          </button>
        )}
        <button
          id={PANEL_CANCEL_ID}
          type="button"
          onClick={closePanel}
          disabled={busy}
          style={{ ...styles.smallButton, ...styles.smallSecondary, ...off(busy) }}
        >
          {confirm ? "Cancel" : "Close"}
        </button>
      </div>
    );
  }

  function panelCheckLine(check: "checking" | "failed") {
    if (check === "checking") return <p style={styles.recoveryText}>Checking what the server holds…</p>;
    return (
      <>
        <p style={styles.recoveryText}>The server could not be checked, so it is still not known what happened.</p>
        <div>
          <button
            type="button"
            onClick={retryPanel}
            disabled={busy}
            style={{ ...styles.smallButton, ...styles.smallSecondary, ...off(busy) }}
          >
            Check again
          </button>
        </div>
      </>
    );
  }

  function renderPanel(current: OpenPanel) {
    return (
      <div role="group" aria-labelledby={PANEL_HEADING_ID} onKeyDown={handlePanelKeyDown} style={styles.panel}>
        <h3 id={PANEL_HEADING_ID} tabIndex={-1} style={styles.panelHeading}>
          {current.kind === "review" ? `Review “${current.title}”` : `Delete “${current.evidence.title}”?`}
        </h3>
        {current.kind === "review" ? reviewBody(current) : deleteBody(current)}
      </div>
    );
  }

  function reviewBody(current: ReviewPanel) {
    const phase = current.phase;
    const intro = <p style={styles.panelText}>{REVIEW_SCOPE_TEXT}</p>;
    switch (phase.kind) {
      case "loading":
        return (
          <>
            {intro}
            {current.notice === "stale" && (
              <p style={styles.recoveryText}>
                This source changed after you opened it, so your review was not recorded. Its current details are being
                loaded.
              </p>
            )}
            <p style={styles.panelText}>Loading the saved details…</p>
            {panelButtons(null)}
          </>
        );
      case "load_failed":
        return (
          <>
            {intro}
            <p style={styles.recoveryText}>
              Could not load the saved details. {failureMessage(phase.failure)} A review can only be confirmed for
              details shown here.
            </p>
            <div>
              <button
                type="button"
                onClick={retryPanel}
                disabled={busy}
                style={{ ...styles.smallButton, ...styles.smallSecondary, ...off(busy) }}
              >
                Try again
              </button>
            </div>
            {panelButtons(null)}
          </>
        );
      case "ready": {
        const unsaved = editor !== null && editor.saved?.id === current.id && !draftMatches(draft, phase.inspected);
        return (
          <>
            {intro}
            {current.notice && (
              <p style={styles.recoveryText}>
                {current.notice === "stale"
                  ? "This source changed after you opened it, so your review was not recorded. Check its current details below and confirm again if they are correct."
                  : current.notice === "changed"
                    ? "This source now holds other details than the ones you inspected. Check its current details below and confirm again if they are correct."
                    : "The server holds no review of this version, so your review was not recorded. You can confirm it again."}
              </p>
            )}
            <p style={styles.panelText}>These are the details saved on the server:</p>
            {reviewDetails(phase.inspected)}
            {unsaved && (
              <p style={styles.recoveryText}>
                The editor above has unsaved entries for this source. This review covers only the saved details shown
                here, not your unsaved entries. Saving changed details later clears the review.
              </p>
            )}
            {phase.error && (
              <p style={{ ...formStyles.errorText, ...formStyles.generalError }}>
                Your review was not recorded. {failureMessage(phase.error)}
              </p>
            )}
            {panelButtons({
              label: "Confirm candidate review",
              pending: "Recording…",
              enabled: true,
              onClick: confirmReviewAction,
            })}
          </>
        );
      }
      case "uncertain":
        return (
          <>
            {intro}
            <p style={styles.recoveryText}>
              {failureMessage(phase.failure)} It is not certain whether your review was recorded. Nothing will be sent
              again automatically.
            </p>
            {panelCheckLine(phase.check)}
            <p style={styles.panelText}>The details you inspected:</p>
            {reviewDetails(phase.inspected)}
            {panelButtons(null)}
          </>
        );
      default:
        return null; // reviewed or missing: the panel is closed
    }
  }

  function deleteBody(current: DeletePanel) {
    const phase = current.phase;
    const e = current.evidence;
    const what = (
      <p style={styles.panelText}>
        This permanently removes the evidence source “{e.title}” ({SOURCE_TYPE_LABELS[e.type]}, added{" "}
        {formatDate(e.createdAt)}). Its links to skills are removed too; your skills themselves are kept. This cannot be
        undone.
      </p>
    );
    if (phase.kind === "confirm") {
      return (
        <>
          {what}
          {phase.stillExists && (
            <>
              <p style={styles.recoveryText}>
                The source still exists on the server. Its current details are shown below. Delete it again, or cancel.
              </p>
              {serverVersion(e)}
            </>
          )}
          {phase.error && (
            <p style={{ ...formStyles.errorText, ...formStyles.generalError }}>
              The source was not deleted. {failureMessage(phase.error)}
            </p>
          )}
          {panelButtons({
            label: "Delete evidence",
            pending: "Deleting…",
            enabled: true,
            danger: true,
            onClick: confirmDeleteAction,
          })}
        </>
      );
    }
    if (phase.kind === "uncertain") {
      return (
        <>
          <p style={styles.recoveryText}>
            {failureMessage(phase.failure)} It is not certain whether “{e.title}” was deleted. Nothing will be sent
            again automatically.
          </p>
          {panelCheckLine(phase.check)}
          {panelButtons(null)}
        </>
      );
    }
    return null; // deleted or absent: the panel is closed
  }

  function checkLine(recovery: Extract<Recovery, { check: CheckState }>, saved: Evidence | null) {
    if (recovery.check === "checking") return <p style={styles.recoveryText}>Checking what the server holds…</p>;
    if (recovery.check === "failed" || !saved) {
      return (
        <>
          <p style={styles.recoveryText}>
            The server could not be checked, so it is still not known what was saved. Your entries and skill selection
            are kept.
          </p>
          <div>
            <button
              type="button"
              onClick={retryCheck}
              disabled={busy}
              style={{ ...styles.smallButton, ...styles.smallSecondary }}
            >
              Check again
            </button>
          </div>
        </>
      );
    }
    return null;
  }

  function recoveryNotice(current: OpenEditor): React.ReactNode {
    const recovery = current.recovery;
    if (!recovery) return undefined;
    const saved = current.saved;
    let body: React.ReactNode;

    switch (recovery.kind) {
      case "create_uncertain": {
        const candidate = adoptCandidate(evidence, adoptId);
        body = (
          <>
            <p style={styles.recoveryText}>
              {failureMessage(recovery.failure)} It is not certain whether the new evidence source was added. Your
              entries and skill selection are kept, and nothing will be sent again automatically.
            </p>
            <p style={styles.recoveryText}>
              {DUPLICATE_RISK_TEXT} Check the list below (use “Refresh”). If the source is there, choose it to continue
              with it. Otherwise you can explicitly add a new source.
            </p>
            <div style={styles.adoptRow}>
              <label htmlFor={ADOPT_SELECT_ID} style={formStyles.label}>
                Source to continue with
              </label>
              <select
                id={ADOPT_SELECT_ID}
                value={adoptId}
                onChange={(e) => setAdoptId(e.target.value)}
                style={{ ...formStyles.input, maxWidth: "100%" }}
              >
                <option value="">Choose a source…</option>
                {evidence.map((e) => (
                  <option key={e.id} value={String(e.id)}>
                    {e.title} — {SOURCE_TYPE_LABELS[e.type]} — added {formatDate(e.createdAt)}
                  </option>
                ))}
              </select>
            </div>
            {candidate ? (
              <>
                <p style={styles.recoveryText}>
                  Values the server currently holds for this source (not your unsaved entries). Candidate review:{" "}
                  {reviewLabel(candidate)}.
                </p>
                {serverVersion(candidate)}
                <p style={styles.recoveryText}>{adoptConsequence(candidate, draft)}</p>
              </>
            ) : (
              adoptId !== "" && (
                <p style={styles.recoveryText}>
                  That source is no longer in the list. Choose another source, or use “Refresh”.
                </p>
              )
            )}
            <div style={styles.itemActions}>
              <button
                type="button"
                onClick={adoptSelected}
                disabled={busy || !candidate}
                style={{ ...styles.smallButton, ...off(busy || !candidate) }}
              >
                Continue with this source
              </button>
              <button
                type="button"
                onClick={createAnew}
                disabled={busy}
                style={{ ...styles.smallButton, ...styles.smallSecondary }}
              >
                Add as a new source anyway
              </button>
            </div>
          </>
        );
        break;
      }
      case "content_uncertain":
        body = (
          <>
            <p style={styles.recoveryText}>
              {failureMessage(recovery.failure)} It is not certain whether your changes to the source were saved.
              Nothing will be sent again automatically.
            </p>
            {checkLine(recovery, saved)}
            {recovery.check === "done" && saved && (
              <>
                <p style={styles.recoveryText}>
                  {draftMatches(draft, saved)
                    ? CHECK_TEXT.contentMatches
                    : "The server holds this version, which differs from your entries. Save to replace it with your entries, or cancel to keep it."}
                </p>
                {serverVersion(saved)}
              </>
            )}
          </>
        );
        break;
      case "links_uncertain":
        body = (
          <>
            <p style={styles.recoveryText}>
              {failureMessage(recovery.failure)} It is not certain whether the skill links were saved. Your selection is
              kept, and nothing will be sent again automatically.
            </p>
            {checkLine(recovery, saved)}
            {recovery.check === "done" && saved && (
              <>
                <p style={styles.recoveryText}>
                  {linksMatch(saved, intendedSkillIds)
                    ? CHECK_TEXT.linksMatch
                    : "The skills linked on the server still differ from your selection. Save to link your selection."}
                </p>
                {serverVersion(saved)}
              </>
            )}
          </>
        );
        break;
      case "links_not_saved":
        body = (
          <>
            <p style={styles.recoveryText}>
              The source was saved, but its skill links were not
              {recovery.reason
                ? `: ${BLOCKED_LINKS_MESSAGE[recovery.reason]}.`
                : recovery.failure
                  ? `. ${failureMessage(recovery.failure)}`
                  : "."}{" "}
              Your selection is kept.
            </p>
            {checkLine(recovery, saved)}
            {recovery.check === "done" && saved && (
              <>
                <p style={styles.recoveryText}>
                  {linksMatch(saved, intendedSkillIds)
                    ? CHECK_TEXT.linksMatch
                    : "Check your selection, then Save to link it. The source content will not be sent again unless you change it."}
                </p>
                {serverVersion(saved)}
              </>
            )}
          </>
        );
        break;
      case "source_missing":
        body = (
          <>
            <p style={styles.recoveryText}>
              This evidence source no longer exists — it may have been deleted elsewhere. Your entries and skill
              selection are kept: you can add them as a new source, or cancel.
            </p>
            <div>
              <button
                type="button"
                onClick={createAnew}
                disabled={busy}
                style={{ ...styles.smallButton, ...styles.smallSecondary }}
              >
                Add as a new source instead
              </button>
            </div>
          </>
        );
        break;
    }

    return (
      // Focused when it appears and summarized in the status line, so it is
      // not also an alert (which would announce it a second time).
      <div id={RECOVERY_ID} tabIndex={-1} style={styles.recovery}>
        {body}
      </div>
    );
  }

  function renderEditor(current: OpenEditor) {
    const saved = current.saved;
    const pendingCreate = current.recovery?.kind === "create_uncertain";
    const plan = planEvidenceSave({ saved, draft, intendedSkillIds, catalogue: catalogueForPlan });
    const nothingToSave = plan.kind === "unchanged" && saveBlockedReason(current) === null;
    const choices = skillChoices(skills ?? [], saved?.skillIds ?? [], intendedSkillIds);
    const linksDisabledReason =
      catalogue.status === "ready"
        ? null
        : catalogue.status === "loading"
          ? "Loading your skills… Links can be changed once the list has loaded."
          : `Your skill list could not be loaded (${catalogue.message}), so links cannot be changed now. ` +
            "You can still save the source itself; its current links are kept.";
    const hasUnknown = choices.some((c) => c.name === null);
    const offerReload = catalogue.status === "error" || (catalogue.status === "ready" && hasUnknown);

    return (
      <EvidenceForm
        heading={saved ? `Edit “${saved.title}”` : pendingCreate ? "Add evidence (not confirmed)" : "Add evidence"}
        submitLabel={saved ? "Save changes" : "Add evidence"}
        submitId={SUBMIT_ID}
        cancelLabel={nothingToSave && saved ? "Close" : "Cancel"}
        draft={draft}
        intendedSkillIds={intendedSkillIds}
        skillChoices={choices}
        linksDisabledReason={linksDisabledReason}
        onReloadSkills={offerReload ? () => (saved ? retryCheckOrCatalogue(current) : void loadCatalogue()) : null}
        fieldErrors={fieldErrors}
        generalError={generalError}
        notice={recoveryNotice(current)}
        reviewWarning={saveClearsReview(saved, draft)}
        busy={saving}
        disabled={busy}
        saveBlockedReason={saveBlockedReason(current)}
        onChange={updateField}
        onToggleSkill={toggleSkill}
        onSubmit={handleSubmit}
        onCancel={closeEditor}
      />
    );
  }

  // Reload skills for an existing source: the source is read back too, since
  // a skill deleted elsewhere also disappears from its links.
  function retryCheckOrCatalogue(current: OpenEditor) {
    if (hasCheck(current.recovery) && current.saved) {
      void checkSource(current.key, current.saved.id);
      return;
    }
    void loadCatalogue();
    if (current.saved) void reloadSnapshot(current.key, current.saved.id);
  }

  // Refreshes the confirmed version of the open source (never the draft).
  async function reloadSnapshot(key: number, id: number) {
    checkAbortRef.current?.abort();
    const controller = new AbortController();
    checkAbortRef.current = controller;
    const seq = ++checkSeqRef.current;
    let result: EvidenceApiResult<Evidence>;
    try {
      result = await fetchEvidence(id, controller.signal);
    } catch {
      return;
    }
    if (!mountedRef.current || seq !== checkSeqRef.current || editorKeyRef.current !== key) return;
    checkAbortRef.current = null;
    if (result.ok) {
      const fresh = result.data;
      setEditor((current) =>
        current && current.key === key && current.recovery === null ? { ...current, saved: fresh } : current
      );
    } else if (result.failure.kind === "not_found") {
      setEditor((current) =>
        current && current.key === key ? { ...current, recovery: { kind: "source_missing" } } : current
      );
    }
  }

  return (
    <section style={styles.card} aria-labelledby={HEADING_ID} aria-busy={busy || refreshing}>
      <div style={styles.headerRow}>
        {heading}
        <div style={styles.headerActions}>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={busy}
            style={{ ...styles.smallButton, ...styles.smallSecondary, ...off(busy) }}
          >
            {refreshing && !busy ? "Refreshing…" : "Refresh"}
          </button>
          <button
            id={ADD_BUTTON_ID}
            type="button"
            onClick={() => open(null, ADD_BUTTON_ID)}
            disabled={rowActionsDisabled}
            style={{ ...styles.smallButton, ...off(rowActionsDisabled) }}
          >
            Add evidence
          </button>
        </div>
      </div>
      <p style={styles.intro}>
        Record the jobs, projects, CVs and portfolios that show your skills, and link each one to the skills it
        supports. “Candidate-reviewed” means you have confirmed a source’s details yourself; it is not independent
        verification.
      </p>

      <p role="status" style={styles.status}>
        {status}
      </p>
      {notice && (
        <div role="alert" style={styles.notice}>
          <p style={styles.noticeText}>{notice.message}</p>
          {notice.retry && (
            <button
              type="button"
              onClick={handleRefresh}
              disabled={busy}
              style={{ ...styles.smallButton, ...styles.smallSecondary }}
            >
              Reload list
            </button>
          )}
        </div>
      )}
      {catalogue.status === "error" && !editor && (
        <p style={styles.hint}>
          Skill names could not be loaded ({catalogue.message}). Linked skills are shown by count.
        </p>
      )}

      {editor && renderEditor(editor)}

      {evidence.length === 0 ? (
        <p style={styles.empty}>No evidence yet. Use “Add evidence” to record your first source.</p>
      ) : (
        <>
          {editor && (
            <p style={styles.hint}>
              Finish or cancel the open form to edit other sources or to delete the source you are editing.
            </p>
          )}
          {!editor && panel?.kind === "delete" && (
            <p style={styles.hint}>Confirm or cancel the deletion to add or edit sources.</p>
          )}
          <ul style={styles.list} aria-label="Evidence sources">
            {evidence.map((item) => {
              const reviewed = reviewLabel(item);
              const reviewDisabled = busy || (panel?.kind === "review" && panel.id === item.id);
              const deleteDisabled =
                busy || editor?.saved?.id === item.id || (panel?.kind === "delete" && panel.id === item.id);
              return (
                <li key={item.id} style={styles.item}>
                  <div style={styles.itemMain}>
                    <p style={styles.itemTitle}>{item.title}</p>
                    <ul style={styles.summary} aria-label={`Details for ${item.title}`}>
                      <li style={styles.chip}>{SOURCE_TYPE_LABELS[item.type]}</li>
                      <li
                        style={{
                          ...styles.chip,
                          ...(reviewed === NOT_REVIEWED_LABEL ? styles.chipMuted : styles.chipReviewed),
                        }}
                      >
                        {reviewed}
                      </li>
                      <li style={styles.chip}>Added {formatDate(item.createdAt)}</li>
                    </ul>
                    <p style={styles.meta}>
                      <span style={styles.metaLabel}>Skills: </span>
                      {skillNames(item.skillIds)}
                    </p>
                    {item.url && <p style={styles.meta}>{item.url}</p>}
                    {item.description && <p style={styles.notes}>{item.description}</p>}
                  </div>
                  <div style={styles.itemActions}>
                    <button
                      id={editButtonId(item.id)}
                      type="button"
                      onClick={() => open(item, editButtonId(item.id))}
                      disabled={rowActionsDisabled}
                      aria-label={`Edit ${item.title}`}
                      style={{ ...styles.smallButton, ...styles.smallSecondary, ...off(rowActionsDisabled) }}
                    >
                      Edit
                    </button>
                    <button
                      id={reviewButtonId(item.id)}
                      type="button"
                      onClick={() => openPanel(openReview(item), reviewButtonId(item.id), PANEL_HEADING_ID)}
                      disabled={reviewDisabled}
                      aria-label={`Review ${item.title}`}
                      style={{ ...styles.smallButton, ...styles.smallSecondary, ...off(reviewDisabled) }}
                    >
                      Review
                    </button>
                    <button
                      id={deleteButtonId(item.id)}
                      type="button"
                      onClick={() => openPanel(openDelete(item), deleteButtonId(item.id), PANEL_CANCEL_ID)}
                      disabled={deleteDisabled}
                      aria-label={`Delete ${item.title}`}
                      style={{ ...styles.smallButton, ...styles.smallSecondary, ...off(deleteDisabled) }}
                    >
                      Delete
                    </button>
                  </div>
                  {panel?.id === item.id && renderPanel(panel)}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

const off = (disabled: boolean) => (disabled ? formStyles.disabled : {});

// Same look as SkillsSection.
const styles: Record<string, React.CSSProperties> = {
  card: {
    border: "1px solid #ddd",
    borderRadius: 8,
    padding: 24,
    background: "#fafafa",
    marginTop: 24,
    minWidth: 0,
  },
  headerRow: { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 },
  headerActions: { display: "flex", flexWrap: "wrap", gap: 8 },
  cardTitle: { fontSize: 16, fontWeight: 600, margin: 0, color: "#444" },
  intro: { fontSize: 14, color: "#555", margin: "8px 0 12px", lineHeight: 1.5 },
  status: { fontSize: 14, color: "#1a5e1a", margin: "0 0 12px", minHeight: "1em" },
  notice: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 12,
    padding: "10px 12px",
    marginBottom: 16,
    border: "1px solid #e0b252",
    borderRadius: 6,
    background: "#fff8e6",
  },
  recovery: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: "10px 12px",
    border: "1px solid #e0b252",
    borderRadius: 6,
    background: "#fff8e6",
    minWidth: 0,
  },
  noticeText: {
    margin: 0,
    fontSize: 14,
    color: "#5c3d00",
    flex: "1 1 200px",
    overflowWrap: "anywhere",
    lineHeight: 1.5,
  },
  // Column layout: no flex basis, which would stretch each paragraph.
  recoveryText: { margin: 0, fontSize: 14, color: "#5c3d00", overflowWrap: "anywhere", lineHeight: 1.5 },
  adoptRow: { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 },
  serverVersion: {
    display: "grid",
    // One column, label above value: a label column leaves too little width
    // for the values inside a row panel on a narrow screen.
    gridTemplateColumns: "minmax(0, 1fr)",
    gap: 2,
    margin: 0,
    padding: 10,
    background: "#fff",
    border: "1px solid #e2e2e2",
    borderRadius: 6,
    fontSize: 14,
  },
  dt: { fontWeight: 600, color: "#333" },
  dd: { margin: "0 0 6px", color: "#222", overflowWrap: "anywhere" },
  hint: { fontSize: 13, color: "#555", margin: "0 0 8px" },
  empty: { fontSize: 14, color: "#555", margin: 0 },
  list: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 12 },
  item: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: 12,
    padding: 14,
    border: "1px solid #e2e2e2",
    borderRadius: 6,
    background: "#fff",
    minWidth: 0,
  },
  itemMain: { flex: "1 1 240px", minWidth: 0 },
  itemTitle: { fontSize: 15, fontWeight: 600, color: "#222", margin: 0, overflowWrap: "anywhere" },
  summary: { listStyle: "none", margin: "8px 0 0", padding: 0, display: "flex", flexWrap: "wrap", gap: 6 },
  chip: {
    fontSize: 12,
    color: "#333",
    background: "#eef1f8",
    borderRadius: 4,
    padding: "2px 8px",
    overflowWrap: "anywhere",
  },
  chipReviewed: { background: "#e3f2e3", color: "#1a5e1a" },
  chipMuted: { background: "#f1f1f1", color: "#444" },
  meta: { fontSize: 14, color: "#444", margin: "8px 0 0", overflowWrap: "anywhere" },
  metaLabel: { fontWeight: 600 },
  notes: {
    fontSize: 14,
    color: "#444",
    margin: "8px 0 0",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    lineHeight: 1.5,
  },
  itemActions: { display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 8 },
  smallButton: {
    padding: "6px 14px",
    fontSize: 15,
    fontWeight: 600,
    color: "#fff",
    background: "#1f4fd1",
    border: "1px solid #1f4fd1",
    borderRadius: 6,
    cursor: "pointer",
  },
  smallSecondary: { color: "#1f4fd1", background: "#fff" },
  danger: { background: "#b00020", borderColor: "#b00020", color: "#fff" },
  // Review/delete panel below a row's content, across the full row width.
  panel: {
    flex: "1 1 100%",
    display: "flex",
    flexDirection: "column",
    gap: 10,
    minWidth: 0,
    padding: "10px 12px",
    border: "1px solid #c9d3ec",
    borderRadius: 6,
    background: "#f6f8fd",
  },
  panelHeading: { fontSize: 15, fontWeight: 600, color: "#222", margin: 0, overflowWrap: "anywhere" },
  panelText: { margin: 0, fontSize: 14, color: "#333", overflowWrap: "anywhere", lineHeight: 1.5 },
};
