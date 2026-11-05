import type { FormEvent, ReactNode } from "react";
import { characterCount } from "./profile.ts";
import {
  EVIDENCE_LIMITS,
  SOURCE_TYPE_OPTIONS,
  type EvidenceDraft,
  type EvidenceDraftField,
  type EvidenceFieldErrors,
  type EvidenceSourceType,
} from "./evidence.ts";
import type { SkillChoice } from "./evidenceEditor.ts";
import { styles } from "./SkillForm.tsx";

// Create/edit form for one evidence source. Fully controlled: the source
// content draft, the intended skill selection, the errors and the
// submit/cancel handling live in EvidenceSection, so a failed or uncertain
// save never loses what the candidate typed or selected.
//
// The content fields and the skill checkboxes are kept apart: they are saved
// by different requests, and the links can be unavailable on their own.

const LABELS: Record<EvidenceDraftField, string> = {
  type: "Source type",
  title: "Title",
  description: "Description",
  url: "Link (optional)",
};

export const evidenceFieldId = (field: EvidenceDraftField | "skillIds") => `evidence-${field}`;
export const skillCheckboxId = (id: number) => `evidence-skill-${id}`;

function describedBy(id: string, hasHint: boolean, hasError: boolean): string | undefined {
  return [hasHint ? `${id}-hint` : "", hasError ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
}

export default function EvidenceForm({
  heading,
  submitLabel,
  submitId,
  cancelLabel,
  draft,
  intendedSkillIds,
  skillChoices,
  linksDisabledReason,
  onReloadSkills,
  fieldErrors,
  generalError,
  notice,
  reviewWarning,
  busy,
  disabled,
  saveBlockedReason,
  onChange,
  onToggleSkill,
  onSubmit,
  onCancel,
}: {
  heading: string;
  submitLabel: string;
  submitId: string;
  cancelLabel: string;
  draft: EvidenceDraft;
  intendedSkillIds: readonly number[];
  skillChoices: readonly SkillChoice[];
  // Why the checkboxes cannot be changed (skill list not loaded), or null.
  linksDisabledReason: string | null;
  onReloadSkills: (() => void) | null;
  fieldErrors: EvidenceFieldErrors;
  generalError: string | null;
  notice?: ReactNode;
  reviewWarning: boolean;
  busy: boolean; // this form's own save is in flight
  disabled: boolean; // any request that blocks the form is in flight
  saveBlockedReason: string | null;
  onChange: <F extends EvidenceDraftField>(field: F, value: EvidenceDraft[F]) => void;
  onToggleSkill: (id: number, checked: boolean) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }

  const titleCount = characterCount(draft.title);
  const descriptionCount = characterCount(draft.description);
  const invalid = (field: EvidenceDraftField) => (fieldErrors[field] ? styles.inputInvalid : {});
  const control = (field: EvidenceDraftField, hasHint = true) => ({
    id: evidenceFieldId(field),
    name: field,
    // Read-only while a save is in flight, so nothing typed then is lost
    // when the editor closes on success.
    disabled: busy,
    "aria-invalid": fieldErrors[field] ? true : undefined,
    "aria-describedby": describedBy(evidenceFieldId(field), hasHint, Boolean(fieldErrors[field])),
  });

  const skillsId = evidenceFieldId("skillIds");
  const saveDisabled = disabled || saveBlockedReason !== null;
  const blockedId = `${submitId}-blocked`;

  return (
    <form onSubmit={handleSubmit} noValidate style={styles.form} aria-labelledby="evidence-form-heading">
      <h3 id="evidence-form-heading" style={styles.heading}>
        {heading}
      </h3>
      {notice}

      <Field field="type" errors={fieldErrors.type}>
        <select
          {...control("type", false)}
          value={draft.type}
          onChange={(e) => onChange("type", e.target.value as EvidenceSourceType)}
          style={{ ...styles.input, ...invalid("type") }}
        >
          {SOURCE_TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>

      <Field
        field="title"
        errors={fieldErrors.title}
        required
        hint={
          <span style={titleCount > EVIDENCE_LIMITS.title ? styles.errorText : undefined}>
            Required, e.g. a job, project or document name. {titleCount} / {EVIDENCE_LIMITS.title} characters
            {titleCount > EVIDENCE_LIMITS.title ? " — over the limit" : ""}
          </span>
        }
      >
        <input
          {...control("title")}
          type="text"
          autoComplete="off"
          value={draft.title}
          aria-required="true"
          onChange={(e) => onChange("title", e.target.value)}
          style={{ ...styles.input, ...invalid("title") }}
        />
      </Field>

      <Field
        field="description"
        errors={fieldErrors.description}
        hint={
          <span style={descriptionCount > EVIDENCE_LIMITS.description ? styles.errorText : undefined}>
            Optional. What you did and what it shows. {descriptionCount.toLocaleString()} /{" "}
            {EVIDENCE_LIMITS.description.toLocaleString()} characters
            {descriptionCount > EVIDENCE_LIMITS.description ? " — over the limit" : ""}
          </span>
        }
      >
        <textarea
          {...control("description")}
          rows={4}
          value={draft.description}
          onChange={(e) => onChange("description", e.target.value)}
          style={{ ...styles.input, ...styles.textarea, ...invalid("description") }}
        />
      </Field>

      <Field
        field="url"
        errors={fieldErrors.url}
        hint="A full http:// or https:// address, such as a repository or portfolio page. It is stored, never opened."
      >
        <input
          {...control("url")}
          type="url"
          inputMode="url"
          autoComplete="off"
          value={draft.url}
          onChange={(e) => onChange("url", e.target.value)}
          style={{ ...styles.input, ...invalid("url") }}
        />
      </Field>

      <fieldset
        id={skillsId}
        tabIndex={-1}
        style={styles.fieldset}
        aria-describedby={describedBy(skillsId, true, Boolean(fieldErrors.skillIds))}
        aria-invalid={fieldErrors.skillIds ? true : undefined}
      >
        <legend style={styles.legend}>Skills this source supports</legend>
        <p id={`${skillsId}-hint`} style={styles.hint}>
          {linksDisabledReason ??
            "Select every skill this source shows, or none. Links are saved after the source itself."}
        </p>
        {onReloadSkills && (
          <div>
            <button type="button" onClick={onReloadSkills} disabled={disabled} style={smallSecondary(disabled)}>
              Reload skills
            </button>
          </div>
        )}
        {skillChoices.length === 0 ? (
          linksDisabledReason ? null : (
            <p style={styles.hint}>You have no skills yet. Add them under “My skills” to link them here.</p>
          )
        ) : (
          <div style={styles.checkboxGrid}>
            {skillChoices.map((choice) => (
              <label key={choice.id} htmlFor={skillCheckboxId(choice.id)} style={styles.checkboxLabel}>
                <input
                  id={skillCheckboxId(choice.id)}
                  type="checkbox"
                  name="skillIds"
                  value={choice.id}
                  checked={intendedSkillIds.includes(choice.id)}
                  disabled={busy || linksDisabledReason !== null}
                  onChange={(e) => onToggleSkill(choice.id, e.target.checked)}
                  style={styles.checkbox}
                />
                <span style={{ overflowWrap: "anywhere" }}>
                  {choice.name ??
                    (linksDisabledReason
                      ? `Linked skill #${choice.id}`
                      : `Skill #${choice.id} (not in your loaded skill list)`)}
                </span>
              </label>
            ))}
          </div>
        )}
        <ErrorList id={`${skillsId}-error`} errors={fieldErrors.skillIds} />
      </fieldset>

      {reviewWarning && (
        <p style={styles.hint}>
          This source is candidate-reviewed. Saving changes to its type, title, description or link clears that review;
          changing its skills does not.
        </p>
      )}

      {generalError && (
        <p role="alert" style={{ ...styles.errorText, ...styles.generalError }}>
          {generalError}
        </p>
      )}

      <div style={styles.actions}>
        <button
          id={submitId}
          type="submit"
          disabled={saveDisabled}
          aria-describedby={saveBlockedReason && !disabled ? blockedId : undefined}
          style={{ ...styles.button, ...(busy ? styles.buttonBusy : saveDisabled ? styles.disabled : {}) }}
        >
          {busy ? "Saving…" : submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={disabled}
          style={{ ...styles.secondaryButton, ...(disabled ? styles.disabled : {}) }}
        >
          {cancelLabel}
        </button>
      </div>
      {saveBlockedReason && !disabled && (
        <p id={blockedId} style={styles.hint}>
          {saveBlockedReason}
        </p>
      )}
    </form>
  );
}

function smallSecondary(disabled: boolean): React.CSSProperties {
  return {
    ...styles.secondaryButton,
    padding: "4px 12px",
    fontSize: 14,
    ...(disabled ? styles.disabled : {}),
  };
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
  field: EvidenceDraftField;
  hint?: ReactNode;
  errors?: string[];
  required?: boolean;
  children: ReactNode;
}) {
  const id = evidenceFieldId(field);
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
