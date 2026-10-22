import type { FormEvent, ReactNode } from "react";
import { characterCount } from "./profile.ts";
import {
  CONTEXT_LABELS,
  EXPERIENCE_CONTEXTS,
  SKILL_LIMITS,
  formatExperience,
  parseOptionalInteger,
  toggleContext,
  type SkillFieldErrors,
  type SkillFormField,
  type SkillFormValues,
} from "./skill.ts";

// Shared create/edit form for one skill. Fully controlled: the values, the
// errors and the submit/cancel handling live in SkillsSection, so a failed
// save never loses what the user typed.

const LABELS: Record<SkillFormField, string> = {
  name: "Skill name",
  experienceContexts: "Where you have used it",
  practicalConfidence: "Practical confidence",
  interviewConfidence: "Interview confidence",
  experienceMonths: "Experience (months)",
  lastUsedYear: "Last used (year)",
  notes: "Notes",
};

const CONFIDENCE_OPTIONS = [
  { value: "", label: "Not rated" },
  { value: "1", label: "1 – Very low" },
  { value: "2", label: "2 – Low" },
  { value: "3", label: "3 – Moderate" },
  { value: "4", label: "4 – High" },
  { value: "5", label: "5 – Very high" },
];

export const skillFieldId = (field: SkillFormField) => `skill-${field}`;
export const contextCheckboxId = (context: string) => `skill-experienceContexts-${context}`;

function describedBy(field: SkillFormField, errors: SkillFieldErrors, hasHint = true): string | undefined {
  const ids = [hasHint ? `${skillFieldId(field)}-hint` : "", errors[field] ? `${skillFieldId(field)}-error` : ""];
  return ids.filter(Boolean).join(" ") || undefined;
}

export default function SkillForm({
  heading,
  submitLabel,
  submitId,
  values,
  fieldErrors,
  generalError,
  notice,
  busy,
  disabled,
  onChange,
  onSubmit,
  onCancel,
  extraActions,
}: {
  heading: string;
  submitLabel: string;
  submitId: string;
  values: SkillFormValues;
  fieldErrors: SkillFieldErrors;
  generalError: string | null;
  notice?: ReactNode;
  busy: boolean; // this form's own save is in flight
  disabled: boolean; // any mutation is in flight
  onChange: <F extends SkillFormField>(field: F, value: SkillFormValues[F]) => void;
  onSubmit: () => void;
  onCancel: () => void;
  extraActions?: ReactNode;
}) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }

  const currentYear = new Date().getUTCFullYear();
  const nameCount = characterCount(values.name);
  const notesCount = characterCount(values.notes);
  const months = parseOptionalInteger(values.experienceMonths);

  const invalid = (field: SkillFormField) => (fieldErrors[field] ? styles.inputInvalid : {});

  const textControl = (field: "experienceMonths" | "lastUsedYear", hint: ReactNode) => (
    <Field field={field} errors={fieldErrors[field]} hint={hint}>
      <input
        id={skillFieldId(field)}
        name={field}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={values[field]}
        aria-invalid={fieldErrors[field] ? true : undefined}
        aria-describedby={describedBy(field, fieldErrors)}
        onChange={(e) => onChange(field, e.target.value)}
        style={{ ...styles.input, ...invalid(field) }}
      />
    </Field>
  );

  const confidenceControl = (field: "practicalConfidence" | "interviewConfidence", hint: string) => (
    <Field field={field} errors={fieldErrors[field]} hint={hint}>
      <select
        id={skillFieldId(field)}
        name={field}
        value={values[field]}
        aria-invalid={fieldErrors[field] ? true : undefined}
        aria-describedby={describedBy(field, fieldErrors)}
        onChange={(e) => onChange(field, e.target.value)}
        style={{ ...styles.input, ...invalid(field) }}
      >
        {CONFIDENCE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );

  const contextsId = skillFieldId("experienceContexts");

  return (
    <form onSubmit={handleSubmit} noValidate style={styles.form} aria-labelledby="skill-form-heading">
      <h3 id="skill-form-heading" style={styles.heading}>
        {heading}
      </h3>
      {notice}

      <Field
        field="name"
        errors={fieldErrors.name}
        required
        hint={
          <span style={nameCount > SKILL_LIMITS.name ? styles.errorText : undefined}>
            Required. {nameCount} / {SKILL_LIMITS.name} characters
            {nameCount > SKILL_LIMITS.name ? " — over the limit" : ""}
          </span>
        }
      >
        <input
          id={skillFieldId("name")}
          name="name"
          type="text"
          autoComplete="off"
          value={values.name}
          placeholder="e.g. PostgreSQL"
          aria-required="true"
          aria-invalid={fieldErrors.name ? true : undefined}
          aria-describedby={describedBy("name", fieldErrors)}
          onChange={(e) => onChange("name", e.target.value)}
          style={{ ...styles.input, ...invalid("name") }}
        />
      </Field>

      <fieldset
        id={contextsId}
        style={styles.fieldset}
        aria-describedby={describedBy("experienceContexts", fieldErrors)}
        aria-invalid={fieldErrors.experienceContexts ? true : undefined}
      >
        <legend style={styles.legend}>{LABELS.experienceContexts}</legend>
        <p id={`${contextsId}-hint`} style={styles.hint}>
          Select any that apply, or none.
        </p>
        <div style={styles.checkboxGrid}>
          {EXPERIENCE_CONTEXTS.map((context) => (
            <label key={context} htmlFor={contextCheckboxId(context)} style={styles.checkboxLabel}>
              <input
                id={contextCheckboxId(context)}
                type="checkbox"
                name="experienceContexts"
                value={context}
                checked={values.experienceContexts.includes(context)}
                onChange={(e) =>
                  onChange("experienceContexts", toggleContext(values.experienceContexts, context, e.target.checked))
                }
                style={styles.checkbox}
              />
              {CONTEXT_LABELS[context]}
            </label>
          ))}
        </div>
        <ErrorList id={`${contextsId}-error`} errors={fieldErrors.experienceContexts} />
      </fieldset>

      <div style={styles.grid}>
        {confidenceControl("practicalConfidence", "How well you can use it in real work.")}
        {confidenceControl("interviewConfidence", "How well you can discuss it in an interview.")}
        {textControl(
          "experienceMonths",
          <>
            Whole months, {SKILL_LIMITS.experienceMonthsMin}–{SKILL_LIMITS.experienceMonthsMax.toLocaleString()}.
            Optional.
            {months.ok && months.value !== null && months.value <= SKILL_LIMITS.experienceMonthsMax
              ? ` ≈ ${formatExperience(months.value)}.`
              : ""}
          </>
        )}
        {textControl("lastUsedYear", `Year from ${SKILL_LIMITS.lastUsedYearMin} to ${currentYear}. Optional.`)}
      </div>

      <Field
        field="notes"
        errors={fieldErrors.notes}
        hint={
          <span style={notesCount > SKILL_LIMITS.notes ? styles.errorText : undefined}>
            Optional. {notesCount.toLocaleString()} / {SKILL_LIMITS.notes.toLocaleString()} characters
            {notesCount > SKILL_LIMITS.notes ? " — over the limit" : ""}
          </span>
        }
      >
        <textarea
          id={skillFieldId("notes")}
          name="notes"
          rows={4}
          value={values.notes}
          aria-invalid={fieldErrors.notes ? true : undefined}
          aria-describedby={describedBy("notes", fieldErrors)}
          onChange={(e) => onChange("notes", e.target.value)}
          style={{ ...styles.input, ...styles.textarea, ...invalid("notes") }}
        />
      </Field>

      {generalError && (
        <p role="alert" style={{ ...styles.errorText, ...styles.generalError }}>
          {generalError}
        </p>
      )}

      <div style={styles.actions}>
        <button
          id={submitId}
          type="submit"
          disabled={disabled}
          style={{ ...styles.button, ...(disabled ? styles.buttonBusy : {}) }}
        >
          {busy ? "Saving…" : submitLabel}
        </button>
        {extraActions}
        <button
          type="button"
          onClick={onCancel}
          disabled={disabled}
          style={{ ...styles.secondaryButton, ...(disabled ? styles.disabled : {}) }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function ErrorList({ id, errors }: { id: string; errors?: string[] }) {
  if (!errors) return null;
  return (
    <ul id={id} style={styles.errorList}>
      {errors.map((message, i) => (
        <li key={i} style={styles.errorText}>
          {message}
        </li>
      ))}
    </ul>
  );
}

function Field({
  field,
  hint,
  errors,
  required,
  children,
}: {
  field: SkillFormField;
  hint?: ReactNode;
  errors?: string[];
  required?: boolean;
  children: ReactNode;
}) {
  const id = skillFieldId(field);
  return (
    <div style={styles.field}>
      <label htmlFor={id} style={styles.label}>
        {LABELS[field]}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      {children}
      {hint && (
        <p id={`${id}-hint`} style={styles.hint}>
          {hint}
        </p>
      )}
      <ErrorList id={`${id}-error`} errors={errors} />
    </div>
  );
}

// Matches the profile form's look (ProfileForm.tsx).
export const styles: Record<string, React.CSSProperties> = {
  form: {
    display: "flex",
    flexDirection: "column",
    gap: 18,
    padding: 16,
    border: "1px solid #c9d3ee",
    borderRadius: 8,
    background: "#fff",
    marginBottom: 20,
    minWidth: 0,
  },
  heading: { fontSize: 15, fontWeight: 600, margin: 0, color: "#222", overflowWrap: "anywhere" },
  field: { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 },
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
  fieldset: { border: "none", margin: 0, padding: 0, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 },
  legend: { fontWeight: 600, fontSize: 14, color: "#222", padding: 0, marginBottom: 2 },
  checkboxGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 6 },
  checkboxLabel: { display: "flex", alignItems: "center", gap: 8, fontSize: 15, color: "#222", padding: "4px 0" },
  checkbox: { width: 18, height: 18, margin: 0, flexShrink: 0 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 18 },
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
  disabled: { opacity: 0.55, cursor: "not-allowed" },
  secondaryButton: {
    padding: "9px 18px",
    fontSize: 16,
    fontWeight: 600,
    color: "#1f4fd1",
    background: "#fff",
    border: "1px solid #1f4fd1",
    borderRadius: 6,
    cursor: "pointer",
  },
};
