import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  FORM_FIELDS,
  LIMITS,
  characterCount,
  formValuesEqual,
  groupFieldErrors,
  mergeSavedValues,
  parseTargetRoles,
  toFormValues,
  toProfileInput,
  type FieldErrors,
  type FormField,
  type FormValues,
  type Profile,
  type WorkModel,
} from "./profile.ts";
import { fetchProfile, saveProfile, type ApiFailure } from "./profileApi.ts";

// Candidate profile form: loads the singleton profile, lets the user edit it
// and saves the complete profile with PUT. The backend is authoritative for
// validation; its field errors are shown next to the matching control.

type LoadState = { status: "loading" } | { status: "ready" } | { status: "error"; message: string };

type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; editedWhileSaving: boolean }
  | { status: "failed" };

const LABELS: Record<FormField, string> = {
  headline: "Professional headline",
  experienceSummary: "Experience summary",
  location: "Location",
  targetRoles: "Target roles",
  workModel: "Preferred work model",
  careerInstructions: "Career instructions",
};

const WORK_MODEL_OPTIONS: { value: WorkModel | ""; label: string }[] = [
  { value: "", label: "Not specified" },
  { value: "remote", label: "Remote" },
  { value: "hybrid", label: "Hybrid" },
  { value: "onsite", label: "Onsite" },
  { value: "flexible", label: "Flexible" },
];

function failureMessage(failure: ApiFailure): string {
  switch (failure.kind) {
    case "validation":
    case "bad_request":
      return "The profile could not be saved because some values are invalid.";
    case "too_large":
      return "The profile is too large to save. Please shorten the longer fields.";
    case "unavailable":
      return "The database is currently unavailable. Please try again in a moment.";
    case "network":
      return "Could not reach the JobFlow server. Check that it is running and try again.";
    case "invalid_response":
      return "The server sent an unexpected response. Please try again.";
    case "server":
      return "Something went wrong on the server. Please try again.";
  }
}

const fieldId = (field: FormField) => `profile-${field}`;

export default function ProfileForm() {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  // Last profile confirmed by the server (null = none saved yet).
  const [saved, setSaved] = useState<Profile | null>(null);
  const [values, setValues] = useState<FormValues>(() => toFormValues(null));
  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [generalError, setGeneralError] = useState<string | null>(null);

  // Synchronous duplicate-submit guard: state updates are not visible to a
  // second submit event fired before React re-renders.
  const savingRef = useRef(false);
  const saveAbortRef = useRef<AbortController | null>(null);
  const focusFirstErrorRef = useRef(false);
  // Latest form values, read after an awaited save to merge server values.
  const valuesRef = useRef(values);
  useEffect(() => {
    valuesRef.current = values;
  }, [values]);

  // Initial load (and retry). Aborting on cleanup means a response that
  // arrives after unmount, or after a newer load started, is ignored.
  useEffect(() => {
    const controller = new AbortController();
    fetchProfile(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.ok) {
          setSaved(result.data);
          setValues(toFormValues(result.data));
          setLoad({ status: "ready" });
        } else {
          setLoad({ status: "error", message: failureMessage(result.failure) });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoad({ status: "error", message: failureMessage({ kind: "network" }) });
        }
      });
    return () => controller.abort();
  }, [reloadKey]);

  // Cancel an in-flight save if the form unmounts.
  useEffect(() => () => saveAbortRef.current?.abort(), []);

  // After a failed validation, move keyboard focus to the first invalid field.
  useEffect(() => {
    if (!focusFirstErrorRef.current) return;
    focusFirstErrorRef.current = false;
    const first = FORM_FIELDS.find((field) => fieldErrors[field]);
    if (first) document.getElementById(fieldId(first))?.focus();
  }, [fieldErrors]);

  function retryLoad() {
    setLoad({ status: "loading" });
    setReloadKey((key) => key + 1);
  }

  function update(field: FormField, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    // This field's errors are stale once it changes.
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
    setSave((current) => (current.status === "saving" ? current : { status: "idle" }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingRef.current) return;
    savingRef.current = true;

    const submitted = values;
    setSave({ status: "saving" });
    setFieldErrors({});
    setGeneralError(null);
    const controller = new AbortController();
    saveAbortRef.current = controller;

    try {
      const result = await saveProfile(toProfileInput(submitted), controller.signal);
      if (controller.signal.aborted) return;

      if (result.ok) {
        const savedValues = toFormValues(result.data);
        const next = mergeSavedValues(valuesRef.current, submitted, savedValues);
        setSaved(result.data);
        setValues(next);
        setSave({ status: "saved", editedWhileSaving: !formValuesEqual(next, savedValues) });
        return;
      }

      setSave({ status: "failed" });
      if (result.failure.kind === "validation") {
        const grouped = groupFieldErrors(result.failure.details);
        setFieldErrors(grouped.fieldErrors);
        setGeneralError(grouped.general.length > 0 ? grouped.general.join(" ") : null);
        focusFirstErrorRef.current = true;
      } else {
        setGeneralError(failureMessage(result.failure));
      }
    } catch {
      if (!controller.signal.aborted) {
        setSave({ status: "failed" });
        setGeneralError(failureMessage({ kind: "network" }));
      }
    } finally {
      savingRef.current = false;
    }
  }

  if (load.status === "loading") {
    return (
      <section style={styles.card} aria-labelledby="profile-heading" aria-busy="true">
        <h2 id="profile-heading" style={styles.cardTitle}>Candidate profile</h2>
        <p role="status">Loading profile…</p>
      </section>
    );
  }

  if (load.status === "error") {
    // The form is not shown: without knowing the saved profile, saving an
    // empty form could overwrite it.
    return (
      <section style={styles.card} aria-labelledby="profile-heading">
        <h2 id="profile-heading" style={styles.cardTitle}>Candidate profile</h2>
        <p role="alert" style={styles.errorText}>Could not load your profile. {load.message}</p>
        <button type="button" onClick={retryLoad} style={styles.button}>Try again</button>
      </section>
    );
  }

  const saving = save.status === "saving";
  const hasFieldErrors = FORM_FIELDS.some((field) => fieldErrors[field]);
  const unsaved = !formValuesEqual(values, toFormValues(saved));
  const roles = parseTargetRoles(values.targetRoles);
  const longRole = roles.some((role) => characterCount(role) > LIMITS.targetRoleLength);

  let statusText = "";
  if (save.status === "saving") statusText = "Saving…";
  else if (save.status === "saved")
    statusText = save.editedWhileSaving
      ? "Profile saved. Changes made while saving are not saved yet."
      : "Profile saved.";
  else if (save.status === "failed" && hasFieldErrors)
    statusText = "Profile not saved. Please correct the fields marked below.";
  else if (save.status === "failed") statusText = "Profile not saved.";

  const textInput = (field: FormField, opts: { limit: number; multiline?: boolean; rows?: number }) => {
    const count = characterCount(values[field]);
    const over = count > opts.limit;
    const hint = (
      <span style={over ? styles.errorText : undefined}>
        {count.toLocaleString()} / {opts.limit.toLocaleString()} characters{over ? " — over the limit" : ""}
      </span>
    );
    const props = {
      id: fieldId(field),
      name: field,
      value: values[field],
      "aria-invalid": fieldErrors[field] ? true : undefined,
      "aria-describedby": describedBy(field, fieldErrors),
    } as const;
    return (
      <Field field={field} hint={hint} errors={fieldErrors[field]}>
        {opts.multiline ? (
          <textarea
            {...props}
            rows={opts.rows ?? 5}
            onChange={(e) => update(field, e.target.value)}
            style={{ ...styles.input, ...styles.textarea, ...(fieldErrors[field] ? styles.inputInvalid : {}) }}
          />
        ) : (
          <input
            {...props}
            type="text"
            onChange={(e) => update(field, e.target.value)}
            style={{ ...styles.input, ...(fieldErrors[field] ? styles.inputInvalid : {}) }}
          />
        )}
      </Field>
    );
  };

  return (
    <section style={styles.card} aria-labelledby="profile-heading">
      <h2 id="profile-heading" style={styles.cardTitle}>Candidate profile</h2>
      <p style={styles.intro}>
        {saved === null
          ? "No profile saved yet. All fields are optional — fill in what you have and save; you can complete it later."
          : `All fields are optional. Last saved ${new Date(saved.updatedAt).toLocaleString()}.`}
      </p>

      <form onSubmit={handleSubmit} noValidate style={styles.form}>
        {textInput("headline", { limit: LIMITS.headline })}
        {textInput("experienceSummary", { limit: LIMITS.experienceSummary, multiline: true, rows: 6 })}
        {textInput("location", { limit: LIMITS.location })}

        <Field
          field="targetRoles"
          errors={fieldErrors.targetRoles}
          hint={
            <span style={roles.length > LIMITS.targetRolesCount || longRole ? styles.errorText : undefined}>
              Separate roles with commas. {roles.length} of {LIMITS.targetRolesCount} roles
              {longRole ? `; each role can be at most ${LIMITS.targetRoleLength} characters` : ""}.
            </span>
          }
        >
          <input
            id={fieldId("targetRoles")}
            name="targetRoles"
            type="text"
            value={values.targetRoles}
            placeholder="e.g. Backend Engineer, Platform Engineer"
            aria-invalid={fieldErrors.targetRoles ? true : undefined}
            aria-describedby={describedBy("targetRoles", fieldErrors)}
            onChange={(e) => update("targetRoles", e.target.value)}
            style={{ ...styles.input, ...(fieldErrors.targetRoles ? styles.inputInvalid : {}) }}
          />
        </Field>

        <Field field="workModel" errors={fieldErrors.workModel}>
          <select
            id={fieldId("workModel")}
            name="workModel"
            value={values.workModel}
            aria-invalid={fieldErrors.workModel ? true : undefined}
            aria-describedby={describedBy("workModel", fieldErrors, false)}
            onChange={(e) => update("workModel", e.target.value)}
            style={{ ...styles.input, ...(fieldErrors.workModel ? styles.inputInvalid : {}) }}
          >
            {WORK_MODEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        {textInput("careerInstructions", { limit: LIMITS.careerInstructions, multiline: true, rows: 4 })}

        {generalError && (
          <p role="alert" style={{ ...styles.errorText, ...styles.generalError }}>
            {generalError}
          </p>
        )}

        <div style={styles.actions}>
          <button type="submit" disabled={saving} style={{ ...styles.button, ...(saving ? styles.buttonBusy : {}) }}>
            {saving ? "Saving…" : "Save profile"}
          </button>
          <p role="status" style={{ ...styles.status, ...(save.status === "failed" ? styles.errorText : {}) }}>
            {statusText}
          </p>
          {unsaved && !saving && <p style={styles.unsaved}>You have unsaved changes.</p>}
        </div>
      </form>
    </section>
  );
}

function describedBy(field: FormField, errors: FieldErrors, hasHint = true): string | undefined {
  const ids = [hasHint ? `${fieldId(field)}-hint` : "", errors[field] ? `${fieldId(field)}-error` : ""];
  return ids.filter(Boolean).join(" ") || undefined;
}

function Field({
  field,
  hint,
  errors,
  children,
}: {
  field: FormField;
  hint?: ReactNode;
  errors?: string[];
  children: ReactNode;
}) {
  const id = fieldId(field);
  return (
    <div style={styles.field}>
      <label htmlFor={id} style={styles.label}>
        {LABELS[field]}
      </label>
      {children}
      {hint && (
        <p id={`${id}-hint`} style={styles.hint}>
          {hint}
        </p>
      )}
      {errors && (
        <ul id={`${id}-error`} style={styles.errorList}>
          {errors.map((message, i) => (
            <li key={i} style={styles.errorText}>
              {message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    border: "1px solid #ddd",
    borderRadius: 8,
    padding: 24,
    background: "#fafafa",
    marginTop: 24,
  },
  cardTitle: { fontSize: 16, fontWeight: 600, marginBottom: 8, color: "#444" },
  intro: { fontSize: 14, color: "#555", marginBottom: 20, lineHeight: 1.5 },
  form: { display: "flex", flexDirection: "column", gap: 20 },
  field: { display: "flex", flexDirection: "column", gap: 6 },
  label: { fontWeight: 600, fontSize: 14, color: "#222" },
  // 16px text avoids mobile zoom-on-focus; the #767676 border keeps 4.5:1
  // contrast on white. The browser's default focus outline is left intact.
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "8px 10px",
    fontSize: 16,
    fontFamily: "inherit",
    color: "#111",
    background: "#fff",
    border: "1px solid #767676",
    borderRadius: 6,
  },
  textarea: { resize: "vertical", lineHeight: 1.5 },
  inputInvalid: { borderColor: "#b00020", borderWidth: 2 },
  hint: { fontSize: 13, color: "#555", margin: 0 },
  errorList: { margin: 0, paddingLeft: 18, fontSize: 13 },
  errorText: { color: "#b00020" },
  generalError: { fontSize: 14, margin: 0 },
  actions: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 },
  button: {
    padding: "10px 20px",
    fontSize: 16,
    fontWeight: 600,
    color: "#fff",
    background: "#1f4fd1",
    border: "none",
    borderRadius: 6,
    cursor: "pointer",
  },
  buttonBusy: { background: "#5a6f9e", cursor: "progress" },
  status: { fontSize: 14, color: "#1a5e1a", margin: 0, minHeight: "1em" },
  unsaved: { fontSize: 13, color: "#555", margin: 0, width: "100%" },
};
