import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import SkillForm, { contextCheckboxId, skillFieldId, styles as formStyles } from "./SkillForm.tsx";
import {
  EMPTY_SKILL_FORM,
  firstErrorField,
  groupSkillFieldErrors,
  neighborId,
  skillSummary,
  toSkillFormValues,
  toSkillInput,
  type Skill,
  type SkillFieldErrors,
  type SkillFormField,
  type SkillFormValues,
} from "./skill.ts";
import {
  createSkill,
  deleteSkill,
  fetchSkills,
  replaceSkill,
  writeOutcomeUnknown,
  type SkillApiFailure,
  type SkillApiResult,
} from "./skillsApi.ts";

// "My skills": lists the candidate's skills in server order and lets the user
// add, edit (full replacement) and delete them.
//
// Mutations are pessimistic: nothing in the list changes until the server has
// confirmed a write and the list has been reloaded from it. Only one editor
// and one mutation exist at a time. A write whose outcome is unknown (network
// failure, 5xx, unexpected response) is never retried automatically; the list
// is reloaded instead so the user can see what the server actually holds.

type ListState = { status: "loading" } | { status: "ready"; skills: Skill[] } | { status: "error"; message: string };

type Editor =
  | { mode: "create"; returnFocusId: string }
  | { mode: "edit"; id: number; name: string; notFound: boolean; returnFocusId: string };

type Mutation = { kind: "save" } | { kind: "delete"; id: number };

type LoadOutcome = { kind: "ok"; skills: Skill[] } | { kind: "failed"; message: string } | { kind: "superseded" };

// Section-level message; retry offers a reload of the list (never a write).
type Notice = { message: string; retry: boolean };

const ADD_BUTTON_ID = "skills-add";
const HEADING_ID = "skills-heading";
const SUBMIT_ID = "skill-submit";
const editButtonId = (id: number) => `skill-${id}-edit`;
const deleteButtonId = (id: number) => `skill-${id}-delete`;
const keepButtonId = (id: number) => `skill-${id}-keep`;

function failureMessage(failure: SkillApiFailure): string {
  switch (failure.kind) {
    case "validation":
    case "bad_request":
      return "The request was rejected because some values are invalid.";
    case "not_found":
      return "That skill no longer exists.";
    case "duplicate":
      return "A skill with this name already exists.";
    case "too_large":
      return "The skill is too large to save. Please shorten the notes.";
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

const DUPLICATE_MESSAGE =
  "A skill with this name already exists. Names are compared ignoring capitalization and extra spaces.";

export default function SkillsSection() {
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [values, setValues] = useState<SkillFormValues>(EMPTY_SKILL_FORM);
  const [fieldErrors, setFieldErrors] = useState<SkillFieldErrors>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [mutation, setMutation] = useState<Mutation | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);

  // Synchronous single-mutation guard: state updates are not visible to a
  // second click fired before React re-renders.
  const mutatingRef = useRef(false);
  const mutationAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  // Only the newest list request may update state; older ones are aborted
  // and their responses ignored.
  const loadSeqRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const loadPromiseRef = useRef<Promise<LoadOutcome> | null>(null);
  // Element ids to focus after the next render, first existing one wins.
  const pendingFocusRef = useRef<string[] | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    void loadSkills();
    return () => {
      mountedRef.current = false;
      loadAbortRef.current?.abort();
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

  function focusIdFor(field: SkillFormField | undefined): string {
    if (field === "experienceContexts") return contextCheckboxId("professional");
    return field ? skillFieldId(field) : SUBMIT_ID;
  }

  function loadSkills(): Promise<LoadOutcome> {
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

    let result: SkillApiResult<Skill[]>;
    try {
      result = await fetchSkills(controller.signal);
    } catch {
      result = { ok: false, failure: { kind: "network" } };
    }
    if (!mountedRef.current) return { kind: "superseded" };
    // A newer load replaced this one: its outcome is the current truth.
    if (seq !== loadSeqRef.current) return loadPromiseRef.current ?? { kind: "superseded" };

    loadAbortRef.current = null;
    setRefreshing(false);
    if (result.ok) {
      setList({ status: "ready", skills: result.data });
      return { kind: "ok", skills: result.data };
    }
    const message = failureMessage(result.failure);
    // Keep a list already shown; the caller warns that it may be out of date.
    setList((current) => (current.status === "ready" ? current : { status: "error", message }));
    return { kind: "failed", message };
  }

  async function handleRefresh() {
    if (mutatingRef.current) return;
    setNotice(null);
    if (list.status === "error") setList({ status: "loading" });
    setStatus("Loading skills…");
    const outcome = await loadSkills();
    if (!mountedRef.current) return;
    if (outcome.kind === "ok") setStatus("Skill list refreshed.");
    else if (outcome.kind === "failed") {
      setStatus("");
      if (list.status === "ready") setNotice({ message: `Could not refresh the skill list. ${outcome.message}`, retry: true });
    }
  }

  function resetForm(next: SkillFormValues) {
    setValues(next);
    setFieldErrors({});
    setGeneralError(null);
  }

  function openCreate() {
    if (mutatingRef.current || editor) return;
    setEditor({ mode: "create", returnFocusId: ADD_BUTTON_ID });
    resetForm({ ...EMPTY_SKILL_FORM, experienceContexts: [] });
    setConfirmDeleteId(null);
    setStatus("");
    focusAfterRender(skillFieldId("name"));
  }

  function openEdit(skill: Skill) {
    if (mutatingRef.current || editor) return;
    setEditor({ mode: "edit", id: skill.id, name: skill.name, notFound: false, returnFocusId: editButtonId(skill.id) });
    resetForm(toSkillFormValues(skill));
    setConfirmDeleteId(null);
    setStatus("");
    focusAfterRender(skillFieldId("name"));
  }

  function closeEditor() {
    if (mutatingRef.current || !editor) return;
    focusAfterRender(editor.returnFocusId, ADD_BUTTON_ID);
    setEditor(null);
    resetForm(EMPTY_SKILL_FORM);
    setStatus("");
  }

  // Keeps the typed values and turns an edit of a deleted skill into a create.
  function switchToCreate() {
    if (mutatingRef.current) return;
    setEditor({ mode: "create", returnFocusId: ADD_BUTTON_ID });
    setFieldErrors({});
    setGeneralError(null);
    setStatus("Your entries are kept. Save them to add them as a new skill.");
    focusAfterRender(skillFieldId("name"));
  }

  function updateField<F extends SkillFormField>(field: F, value: SkillFormValues[F]) {
    setValues((current) => ({ ...current, [field]: value }));
    // This field's errors are stale once it changes.
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  async function handleSubmit() {
    if (!editor || mutatingRef.current) return;
    const target = editor;

    const converted = toSkillInput(values);
    if (!converted.ok) {
      setFieldErrors(converted.fieldErrors);
      setGeneralError(null);
      setStatus("Skill not saved. Please correct the fields marked below.");
      focusAfterRender(focusIdFor(firstErrorField(converted.fieldErrors)));
      return;
    }

    mutatingRef.current = true;
    const controller = new AbortController();
    mutationAbortRef.current = controller;
    setMutation({ kind: "save" });
    setFieldErrors({});
    setGeneralError(null);
    setNotice(null);
    setStatus(target.mode === "create" ? "Adding skill…" : "Saving changes…");

    try {
      let result: SkillApiResult<Skill>;
      try {
        result =
          target.mode === "create"
            ? await createSkill(converted.input, controller.signal)
            : await replaceSkill(target.id, converted.input, controller.signal);
      } catch {
        if (controller.signal.aborted) return; // unmounted
        result = { ok: false, failure: { kind: "network" } };
      }
      if (!mountedRef.current) return;

      if (result.ok) {
        // Confirmed. The editor stays open (busy) until the list is reloaded,
        // so the saved skill appears in its server position, then closes.
        const saved = result.data;
        const outcome = await loadSkills();
        if (!mountedRef.current) return;
        setEditor(null);
        resetForm(EMPTY_SKILL_FORM);
        setStatus(`Skill “${saved.name}” ${target.mode === "create" ? "added" : "saved"}.`);
        if (outcome.kind === "failed") {
          setNotice({
            message: "Your change was saved, but the skill list could not be reloaded, so it may be out of date.",
            retry: true,
          });
        }
        focusAfterRender(editButtonId(saved.id), ADD_BUTTON_ID);
        return;
      }

      const failure = result.failure;
      if (!writeOutcomeUnknown(failure)) {
        // Definite rejection: nothing was written. The typed values are kept.
        setStatus("Skill not saved.");
        if (failure.kind === "validation") {
          const grouped = groupSkillFieldErrors(failure.details);
          setFieldErrors(grouped.fieldErrors);
          setGeneralError(
            grouped.general.length > 0
              ? grouped.general.join(" ")
              : "Some values are invalid. Please correct the fields marked above."
          );
          focusAfterRender(focusIdFor(firstErrorField(grouped.fieldErrors)));
        } else if (failure.kind === "duplicate") {
          setFieldErrors({ name: [DUPLICATE_MESSAGE] });
          focusAfterRender(skillFieldId("name"));
          void loadSkills(); // show the existing skill with that name
        } else if (failure.kind === "not_found" && target.mode === "edit") {
          setEditor({ ...target, notFound: true });
          focusAfterRender(SUBMIT_ID);
          void loadSkills();
        } else {
          setGeneralError(failureMessage(failure));
          focusAfterRender(SUBMIT_ID);
        }
        return;
      }

      // Unknown outcome: the server may or may not have committed the write.
      setStatus("Checking whether the skill was saved…");
      const outcome = await loadSkills();
      if (!mountedRef.current) return;
      const what = target.mode === "create" ? "the new skill was added" : "your changes were saved";
      if (outcome.kind === "ok") {
        setGeneralError(
          `${failureMessage(failure)} It is not certain whether ${what}. The list has been reloaded from the server — ` +
            "check it before saving again. Your entries are kept."
        );
      } else {
        setGeneralError(
          `${failureMessage(failure)} It is not certain whether ${what}, and the skill list could not be reloaded ` +
            "to check. Your entries are kept."
        );
        setNotice({ message: "The skill list could not be reloaded and may be out of date.", retry: true });
      }
      setStatus("Save not confirmed.");
      focusAfterRender(SUBMIT_ID);
    } finally {
      mutatingRef.current = false;
      mutationAbortRef.current = null;
      if (mountedRef.current) setMutation(null);
    }
  }

  function requestDelete(skill: Skill) {
    if (mutatingRef.current || editor) return;
    setConfirmDeleteId(skill.id);
    setStatus("");
    focusAfterRender(keepButtonId(skill.id));
  }

  function cancelDelete(id: number) {
    if (mutatingRef.current) return;
    setConfirmDeleteId(null);
    focusAfterRender(deleteButtonId(id));
  }

  async function confirmDelete(skill: Skill) {
    if (mutatingRef.current) return;
    mutatingRef.current = true;
    const controller = new AbortController();
    mutationAbortRef.current = controller;
    setMutation({ kind: "delete", id: skill.id });
    setNotice(null);
    setStatus(`Deleting “${skill.name}”…`);
    const neighbor = list.status === "ready" ? neighborId(list.skills, skill.id) : null;
    const afterRemoval = neighbor === null ? [ADD_BUTTON_ID] : [editButtonId(neighbor), ADD_BUTTON_ID];

    try {
      let result: SkillApiResult<void>;
      try {
        result = await deleteSkill(skill.id, controller.signal);
      } catch {
        if (controller.signal.aborted) return; // unmounted
        result = { ok: false, failure: { kind: "network" } };
      }
      if (!mountedRef.current) return;

      // 404 means the skill is already gone, which is what the user asked for.
      if (result.ok || result.failure.kind === "not_found") {
        const outcome = await loadSkills();
        if (!mountedRef.current) return;
        setConfirmDeleteId(null);
        setStatus(result.ok ? `Skill “${skill.name}” deleted.` : `Skill “${skill.name}” had already been deleted.`);
        if (outcome.kind === "failed") {
          // The deletion is confirmed, so the row is removed without a reload;
          // the remaining rows keep their server order.
          setList((current) =>
            current.status === "ready"
              ? { status: "ready", skills: current.skills.filter((s) => s.id !== skill.id) }
              : current
          );
          setNotice({
            message: "The skill was deleted, but the skill list could not be reloaded, so it may be out of date.",
            retry: true,
          });
        }
        focusAfterRender(...afterRemoval);
        return;
      }

      const failure = result.failure;
      if (!writeOutcomeUnknown(failure)) {
        setConfirmDeleteId(null);
        setStatus("Skill not deleted.");
        setNotice({ message: `Could not delete “${skill.name}”. ${failureMessage(failure)}`, retry: false });
        focusAfterRender(deleteButtonId(skill.id));
        return;
      }

      // Unknown outcome: reload to see whether the skill still exists.
      setStatus("Checking whether the skill was deleted…");
      const outcome = await loadSkills();
      if (!mountedRef.current) return;
      setConfirmDeleteId(null);
      setStatus("Delete not confirmed.");
      if (outcome.kind === "ok") {
        const stillListed = outcome.skills.some((s) => s.id === skill.id);
        setNotice({
          message:
            `${failureMessage(failure)} It is not certain whether “${skill.name}” was deleted. ` +
            (stillListed
              ? "It is still listed after reloading, so you can try again."
              : "It is no longer listed after reloading."),
          retry: false,
        });
        focusAfterRender(deleteButtonId(skill.id), ...afterRemoval);
      } else {
        setNotice({
          message:
            `${failureMessage(failure)} It is not certain whether “${skill.name}” was deleted, and the skill list ` +
            "could not be reloaded to check.",
          retry: true,
        });
        focusAfterRender(deleteButtonId(skill.id), ...afterRemoval);
      }
    } finally {
      mutatingRef.current = false;
      mutationAbortRef.current = null;
      if (mountedRef.current) setMutation(null);
    }
  }

  function handleConfirmKeyDown(event: KeyboardEvent<HTMLDivElement>, id: number) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelDelete(id);
    }
  }

  const heading = (
    <h2 id={HEADING_ID} tabIndex={-1} style={styles.cardTitle}>
      My skills
    </h2>
  );

  if (list.status === "loading") {
    return (
      <section style={styles.card} aria-labelledby={HEADING_ID} aria-busy="true">
        {heading}
        <p role="status">Loading skills…</p>
      </section>
    );
  }

  if (list.status === "error") {
    // Nothing can be edited without knowing what the server holds.
    return (
      <section style={styles.card} aria-labelledby={HEADING_ID}>
        {heading}
        <p role="alert" style={formStyles.errorText}>
          Could not load your skills. {list.message} Please try again.
        </p>
        <button type="button" onClick={handleRefresh} style={formStyles.button}>
          Try again
        </button>
      </section>
    );
  }

  const skills = list.skills;
  const busy = mutation !== null;
  const rowActionsDisabled = busy || editor !== null;
  const editingMissing =
    editor?.mode === "edit" && (editor.notFound || !skills.some((skill) => skill.id === editor.id));

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
            onClick={openCreate}
            disabled={rowActionsDisabled}
            style={{ ...styles.smallButton, ...off(rowActionsDisabled) }}
          >
            Add skill
          </button>
        </div>
      </div>
      <p style={styles.intro}>
        Record the skills you have, where you used them and how confident you feel. Only the name is required.
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

      {editor && (
        <SkillForm
          heading={editor.mode === "create" ? "Add a skill" : `Edit “${editor.name}”`}
          submitLabel={editor.mode === "create" ? "Add skill" : "Save changes"}
          submitId={SUBMIT_ID}
          values={values}
          fieldErrors={fieldErrors}
          generalError={generalError}
          busy={mutation?.kind === "save"}
          disabled={busy}
          onChange={updateField}
          onSubmit={handleSubmit}
          onCancel={closeEditor}
          notice={
            editingMissing ? (
              <p role="alert" style={{ ...formStyles.errorText, ...formStyles.generalError }}>
                This skill no longer exists — it may have been deleted elsewhere. Your entries are kept: you can add
                them as a new skill, or cancel.
              </p>
            ) : undefined
          }
          extraActions={
            editingMissing ? (
              <button type="button" onClick={switchToCreate} disabled={busy} style={formStyles.secondaryButton}>
                Add as new skill instead
              </button>
            ) : undefined
          }
        />
      )}

      {skills.length === 0 ? (
        <p style={styles.empty}>No skills yet. Use “Add skill” to record your first one.</p>
      ) : (
        <>
          {editor && <p style={styles.hint}>Finish or cancel the open form to edit or delete other skills.</p>}
          <ul style={styles.list} aria-label="Skills">
            {skills.map((skill) => {
              const summary = skillSummary(skill);
              const confirming = confirmDeleteId === skill.id;
              const deleting = mutation?.kind === "delete" && mutation.id === skill.id;
              return (
                <li key={skill.id} style={styles.item}>
                  <div style={styles.itemMain}>
                    <p style={styles.skillName}>{skill.name}</p>
                    {summary.length > 0 && (
                      <ul style={styles.summary} aria-label={`Details for ${skill.name}`}>
                        {summary.map((part) => (
                          <li key={part} style={styles.chip}>
                            {part}
                          </li>
                        ))}
                      </ul>
                    )}
                    {skill.notes && <p style={styles.notes}>{skill.notes}</p>}
                  </div>

                  {confirming ? (
                    <div
                      role="group"
                      aria-labelledby={`skill-${skill.id}-confirm`}
                      onKeyDown={(e) => handleConfirmKeyDown(e, skill.id)}
                      style={styles.confirm}
                    >
                      <p id={`skill-${skill.id}-confirm`} style={styles.confirmText}>
                        Delete “{skill.name}”? This cannot be undone.
                      </p>
                      <div style={styles.itemActions}>
                        <button
                          type="button"
                          onClick={() => confirmDelete(skill)}
                          disabled={busy}
                          style={{ ...styles.smallButton, ...styles.danger, ...(busy ? formStyles.buttonBusy : {}) }}
                        >
                          {deleting ? "Deleting…" : "Delete skill"}
                        </button>
                        <button
                          id={keepButtonId(skill.id)}
                          type="button"
                          onClick={() => cancelDelete(skill.id)}
                          disabled={busy}
                          style={{ ...styles.smallButton, ...styles.smallSecondary, ...off(busy) }}
                        >
                          Keep
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={styles.itemActions}>
                      <button
                        id={editButtonId(skill.id)}
                        type="button"
                        onClick={() => openEdit(skill)}
                        disabled={rowActionsDisabled}
                        aria-label={`Edit ${skill.name}`}
                        style={{ ...styles.smallButton, ...styles.smallSecondary, ...off(rowActionsDisabled) }}
                      >
                        Edit
                      </button>
                      <button
                        id={deleteButtonId(skill.id)}
                        type="button"
                        onClick={() => requestDelete(skill)}
                        disabled={rowActionsDisabled}
                        aria-label={`Delete ${skill.name}`}
                        style={{ ...styles.smallButton, ...styles.smallSecondary, ...off(rowActionsDisabled) }}
                      >
                        Delete
                      </button>
                    </div>
                  )}
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
  noticeText: { margin: 0, fontSize: 14, color: "#5c3d00", flex: "1 1 200px", overflowWrap: "anywhere" },
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
  // Long names and notes wrap anywhere instead of widening the page.
  skillName: { fontSize: 15, fontWeight: 600, color: "#222", margin: 0, overflowWrap: "anywhere" },
  summary: { listStyle: "none", margin: "8px 0 0", padding: 0, display: "flex", flexWrap: "wrap", gap: 6 },
  chip: {
    fontSize: 12,
    color: "#333",
    background: "#eef1f8",
    borderRadius: 4,
    padding: "2px 8px",
    overflowWrap: "anywhere",
  },
  notes: {
    fontSize: 14,
    color: "#444",
    margin: "8px 0 0",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    lineHeight: 1.5,
  },
  itemActions: { display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 8 },
  confirm: { display: "flex", flexDirection: "column", gap: 8, flex: "1 1 200px", minWidth: 0 },
  confirmText: { margin: 0, fontSize: 14, color: "#222", fontWeight: 600, overflowWrap: "anywhere" },
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
};
