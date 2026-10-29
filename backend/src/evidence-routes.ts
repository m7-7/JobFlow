import { Router, type Response } from "express";
import { isForeignKeyViolation } from "./errors.js";
import type { FieldError } from "./profile-validation.js";
import {
  parseEvidenceId,
  validateEvidenceCreate,
  validateEvidenceReplace,
  validateReview,
  validateSkillIds,
} from "./evidence-validation.js";
import {
  createEvidence,
  deleteEvidence,
  getEvidence,
  listEvidence,
  replaceEvidence,
  replaceEvidenceSkills,
  reviewEvidence,
  type StoredEvidence,
} from "./evidence-store.js";

// HTTP layer for candidate evidence sources. Mounted at /evidence; the browser
// reaches it as /api/evidence through the Vite dev-server proxy.
//
// Every source is recorded manually by the candidate. reviewedAt means the
// candidate confirmed the current type, title, description and url; it is not
// independent verification and says nothing about the linked skills.
//
// Database errors other than the foreign key violations handled below are
// forwarded (Express 5 does this for rejected promises) to the error handler
// in app.ts, which maps them to a safe 503/500 response.
export const evidenceRouter = Router();

const SKILL_FK = "candidate_skill_evidence_skill_fk";
const SOURCE_FK = "candidate_skill_evidence_source_fk";

function toJson(evidence: StoredEvidence) {
  return {
    ...evidence,
    reviewedAt: evidence.reviewedAt ? evidence.reviewedAt.toISOString() : null,
    createdAt: evidence.createdAt.toISOString(),
    updatedAt: evidence.updatedAt.toISOString(),
  };
}

function sendValidationError(res: Response, errors: FieldError[], message = "The evidence is invalid.") {
  res.status(400).json({ error: "validation_error", message, details: errors });
}

function sendInvalidId(res: Response) {
  res.status(400).json({ error: "invalid_id", message: "The evidence id must be a positive integer." });
}

function sendNotFound(res: Response) {
  res.status(404).json({ error: "not_found", message: "The evidence source was not found." });
}

const SKILL_LINKS_INVALID = "The skill links are invalid.";

evidenceRouter.get("/", async (_req, res) => {
  const evidence = await listEvidence();
  res.status(200).json(evidence.map(toJson));
});

evidenceRouter.post("/", async (req, res) => {
  const result = validateEvidenceCreate(req.body);
  if (!result.ok) return sendValidationError(res, result.errors);
  res.status(201).json(toJson(await createEvidence(result.value)));
});

evidenceRouter.get("/:id", async (req, res) => {
  const id = parseEvidenceId(req.params.id);
  if (id === null) return sendInvalidId(res);
  const evidence = await getEvidence(id);
  if (!evidence) return sendNotFound(res);
  res.status(200).json(toJson(evidence));
});

evidenceRouter.put("/:id", async (req, res) => {
  const id = parseEvidenceId(req.params.id);
  if (id === null) return sendInvalidId(res);
  const result = validateEvidenceReplace(req.body);
  if (!result.ok) return sendValidationError(res, result.errors);
  const saved = await replaceEvidence(id, result.value);
  if (!saved) return sendNotFound(res);
  res.status(200).json(toJson(saved));
});

evidenceRouter.delete("/:id", async (req, res) => {
  const id = parseEvidenceId(req.params.id);
  if (id === null) return sendInvalidId(res);
  if (!(await deleteEvidence(id))) return sendNotFound(res);
  res.status(204).end();
});

evidenceRouter.put("/:id/skills", async (req, res) => {
  const id = parseEvidenceId(req.params.id);
  if (id === null) return sendInvalidId(res);
  const result = validateSkillIds(req.body);
  if (!result.ok) return sendValidationError(res, result.errors, SKILL_LINKS_INVALID);
  let outcome: Awaited<ReturnType<typeof replaceEvidenceSkills>>;
  try {
    outcome = await replaceEvidenceSkills(id, result.value);
  } catch (err) {
    // Backstops only: the transaction locks the source and the skills before
    // writing, so these violations are not expected to occur.
    if (isForeignKeyViolation(err, SOURCE_FK)) return sendNotFound(res);
    if (isForeignKeyViolation(err, SKILL_FK)) {
      return sendValidationError(res, [{ field: "skillIds", message: "must refer to existing skills" }], SKILL_LINKS_INVALID);
    }
    throw err;
  }
  if (outcome.status === "not_found") return sendNotFound(res);
  if (outcome.status === "missing_skills") {
    const missing = new Set(outcome.missing);
    const errors = result.value.flatMap((skillId, i) =>
      missing.has(skillId) ? [{ field: `skillIds[${i}]`, message: "does not refer to an existing skill" }] : []
    );
    return sendValidationError(res, errors, SKILL_LINKS_INVALID);
  }
  res.status(200).json(toJson(outcome.evidence));
});

evidenceRouter.post("/:id/review", async (req, res) => {
  const id = parseEvidenceId(req.params.id);
  if (id === null) return sendInvalidId(res);
  const result = validateReview(req.body);
  if (!result.ok) return sendValidationError(res, result.errors, "The review request is invalid.");
  const outcome = await reviewEvidence(id, result.value.expectedUpdatedAt);
  if (outcome.status === "not_found") return sendNotFound(res);
  if (outcome.status === "stale") {
    res.status(409).json({
      error: "stale_evidence",
      message: "The evidence source has changed since it was loaded. Reload it and review again.",
    });
    return;
  }
  res.status(200).json(toJson(outcome.evidence));
});
