import { asc, eq, sql } from "drizzle-orm";
import { db } from "./db.js";
import { candidateSkill, type ExperienceContext } from "./schema.js";
import type { SkillInput } from "./skill-validation.js";

// Persistence for candidate skills. Each operation is a single statement:
// there is no separate existence check, so a missing row is detected from
// what the write itself returns, and duplicate names are arbitrated by the
// candidate_skill_name_normalized_unique index.

export const SKILL_NAME_UNIQUE_INDEX = "candidate_skill_name_normalized_unique";

export interface StoredSkill extends SkillInput {
  id: number;
  createdAt: Date;
  updatedAt: Date;
}

type SkillRow = typeof candidateSkill.$inferSelect;

function toStoredSkill(row: SkillRow): StoredSkill {
  return {
    id: row.id,
    name: row.name,
    experienceContexts: row.experienceContexts as ExperienceContext[],
    practicalConfidence: row.practicalConfidence,
    interviewConfidence: row.interviewConfidence,
    experienceMonths: row.experienceMonths,
    lastUsedYear: row.lastUsedYear,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// The same expression as the unique index in schema.ts, so the list is
// ordered by the name the database compares.
const normalizedName = sql`lower(btrim(regexp_replace(${candidateSkill.name}, '[\\t\\n\\v\\f\\r ]+', ' ', 'g')))`;

export async function listSkills(): Promise<StoredSkill[]> {
  const rows = await db.select().from(candidateSkill).orderBy(asc(normalizedName), asc(candidateSkill.id));
  return rows.map(toStoredSkill);
}

export async function createSkill(input: SkillInput): Promise<StoredSkill> {
  const [row] = await db.insert(candidateSkill).values(input).returning();
  return toStoredSkill(row);
}

// Full replacement. updated_at is set on every successful update, including
// one that stores identical values; created_at is never written. Returns null
// when no row has this id.
export async function replaceSkill(id: number, input: SkillInput): Promise<StoredSkill | null> {
  const rows = await db
    .update(candidateSkill)
    .set({ ...input, updatedAt: sql`now()` })
    .where(eq(candidateSkill.id, id))
    .returning();
  return rows[0] ? toStoredSkill(rows[0]) : null;
}

// Returns false when no row has this id.
export async function deleteSkill(id: number): Promise<boolean> {
  const rows = await db.delete(candidateSkill).where(eq(candidateSkill.id, id)).returning({ id: candidateSkill.id });
  return rows.length > 0;
}
