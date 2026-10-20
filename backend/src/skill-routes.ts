import { Router, type Response } from "express";
import { isUniqueViolation } from "./errors.js";
import { parseSkillId, validateSkillCreate, validateSkillReplace, type SkillValidationResult } from "./skill-validation.js";
import {
  SKILL_NAME_UNIQUE_INDEX,
  createSkill,
  deleteSkill,
  listSkills,
  replaceSkill,
  type StoredSkill,
} from "./skill-store.js";

// HTTP layer for candidate skills. Mounted at /skills; the browser reaches it
// as /api/skills through the Vite dev-server proxy.
//
// Only a duplicate-name violation is handled here. Every other database error
// is forwarded (Express 5 does this for rejected promises) to the error
// handler in app.ts, which maps it to a safe 503/500 response.
export const skillRouter = Router();

function toJson(skill: StoredSkill) {
  return { ...skill, createdAt: skill.createdAt.toISOString(), updatedAt: skill.updatedAt.toISOString() };
}

function sendValidationError(res: Response, result: Extract<SkillValidationResult, { ok: false }>) {
  res.status(400).json({ error: "validation_error", message: "The skill is invalid.", details: result.errors });
}

function sendInvalidId(res: Response) {
  res.status(400).json({ error: "invalid_id", message: "The skill id must be a positive integer." });
}

function sendNotFound(res: Response) {
  res.status(404).json({ error: "not_found", message: "The skill was not found." });
}

// Rethrows anything that is not a duplicate name. The message is fixed: it
// never echoes the submitted or the existing name.
function sendDuplicateOrRethrow(res: Response, err: unknown) {
  if (!isUniqueViolation(err, SKILL_NAME_UNIQUE_INDEX)) throw err;
  res.status(409).json({ error: "duplicate_skill", message: "A skill with this name already exists." });
}

skillRouter.get("/", async (_req, res) => {
  const skills = await listSkills();
  res.status(200).json(skills.map(toJson));
});

skillRouter.post("/", async (req, res) => {
  const result = validateSkillCreate(req.body);
  if (!result.ok) return sendValidationError(res, result);
  try {
    res.status(201).json(toJson(await createSkill(result.value)));
  } catch (err) {
    sendDuplicateOrRethrow(res, err);
  }
});

skillRouter.put("/:id", async (req, res) => {
  const id = parseSkillId(req.params.id);
  if (id === null) return sendInvalidId(res);
  const result = validateSkillReplace(req.body);
  if (!result.ok) return sendValidationError(res, result);
  let saved: StoredSkill | null;
  try {
    saved = await replaceSkill(id, result.value);
  } catch (err) {
    return sendDuplicateOrRethrow(res, err);
  }
  if (!saved) return sendNotFound(res);
  res.status(200).json(toJson(saved));
});

skillRouter.delete("/:id", async (req, res) => {
  const id = parseSkillId(req.params.id);
  if (id === null) return sendInvalidId(res);
  if (!(await deleteSkill(id))) return sendNotFound(res);
  res.status(204).end();
});
