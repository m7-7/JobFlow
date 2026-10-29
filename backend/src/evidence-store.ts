import { and, asc, desc, eq, inArray, notInArray, sql, type SQL } from "drizzle-orm";
import { db } from "./db.js";
import { candidateEvidenceSource, candidateSkill, candidateSkillEvidence, type EvidenceSourceType } from "./schema.js";
import type { EvidenceInput } from "./evidence-validation.js";

// Persistence for candidate evidence sources and their skill links.
//
// Content version. updated_at changes exactly when the source content (type,
// title, description, url) changes, and is the version a review attests to.
// The API serializes it with millisecond precision while the column keeps
// microseconds, so every write stores a millisecond value that is also
// strictly later than the previous one, even for edits within the same
// millisecond or after the clock steps back. Each content version of a row
// therefore has a distinct public updatedAt, which a review can compare
// exactly. Linking skills never touches updated_at or reviewed_at.

const src = candidateEvidenceSource;
const link = candidateSkillEvidence;

export interface StoredEvidence extends EvidenceInput {
  id: number;
  origin: string;
  reviewedAt: Date | null;
  skillIds: number[];
  createdAt: Date;
  updatedAt: Date;
}

const MS = sql.raw("'milliseconds'");

// A source with its linked skill ids (ascending) in one statement, so the two
// always come from the same snapshot and the list needs no extra queries.
const evidenceColumns = {
  id: src.id,
  type: src.type,
  title: src.title,
  description: src.description,
  url: src.url,
  origin: src.origin,
  reviewedAt: src.reviewedAt,
  skillIds: sql<number[]>`ARRAY(SELECT ${link.skillId} FROM ${link} WHERE ${link.evidenceSourceId} = ${src.id} ORDER BY ${link.skillId})`,
  createdAt: src.createdAt,
  updatedAt: src.updatedAt,
};

type EvidenceRow = {
  [K in keyof typeof evidenceColumns]: K extends "skillIds" ? number[] : (typeof src.$inferSelect)[K & keyof typeof src.$inferSelect];
};

function toStoredEvidence(row: EvidenceRow): StoredEvidence {
  return {
    id: row.id,
    type: row.type as EvidenceSourceType,
    title: row.title,
    description: row.description,
    url: row.url,
    origin: row.origin,
    reviewedAt: row.reviewedAt,
    skillIds: row.skillIds.map(Number),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listEvidence(): Promise<StoredEvidence[]> {
  const rows = await db.select(evidenceColumns).from(src).orderBy(desc(src.createdAt), desc(src.id));
  return rows.map(toStoredEvidence);
}

export async function getEvidence(id: number): Promise<StoredEvidence | null> {
  const rows = await db.select(evidenceColumns).from(src).where(eq(src.id, id));
  return rows[0] ? toStoredEvidence(rows[0]) : null;
}

// origin takes its database default ('manual'); reviewed_at starts null.
export async function createEvidence(input: EvidenceInput): Promise<StoredEvidence> {
  const now = sql`date_trunc(${MS}, now())`;
  const [row] = await db
    .insert(src)
    .values({ ...input, createdAt: now, updatedAt: now })
    .returning(evidenceColumns);
  return toStoredEvidence(row);
}

// Full replacement of the content, as one statement: the comparison with the
// stored values (null-safe) and the write happen under the same row lock, and
// a concurrent writer's committed row is re-read before this one applies. A
// change advances updated_at and clears reviewed_at; an identical replacement
// leaves both as they were. Returns null when no row has this id.
export async function replaceEvidence(id: number, input: EvidenceInput): Promise<StoredEvidence | null> {
  const changed: SQL = sql`(
    ${src.type} IS DISTINCT FROM ${input.type}::text OR
    ${src.title} IS DISTINCT FROM ${input.title}::varchar OR
    ${src.description} IS DISTINCT FROM ${input.description}::text OR
    ${src.url} IS DISTINCT FROM ${input.url}::varchar
  )`;
  const rows = await db
    .update(src)
    .set({
      ...input,
      updatedAt: sql`CASE WHEN ${changed}
        THEN date_trunc(${MS}, greatest(now(), date_trunc(${MS}, ${src.updatedAt}) + interval '1 millisecond'))
        ELSE ${src.updatedAt} END`,
      reviewedAt: sql`CASE WHEN ${changed} THEN NULL ELSE ${src.reviewedAt} END`,
    })
    .where(eq(src.id, id))
    .returning(evidenceColumns);
  return rows[0] ? toStoredEvidence(rows[0]) : null;
}

// Returns false when no row has this id. Its skill links are removed by the
// foreign key's ON DELETE CASCADE; the skills themselves are untouched.
export async function deleteEvidence(id: number): Promise<boolean> {
  const rows = await db.delete(src).where(eq(src.id, id)).returning({ id: src.id });
  return rows.length > 0;
}

export type ReviewOutcome = { status: "ok"; evidence: StoredEvidence } | { status: "not_found" } | { status: "stale" };

// Records that the candidate reviewed the content version whose public
// updatedAt is expectedUpdatedAt. The version check and the write are one
// statement, so an edit committed first makes it match nothing (stale), and
// an edit committed after it clears the review again. updated_at is
// unchanged. The follow-up read only tells a stale version from a missing row.
export async function reviewEvidence(id: number, expectedUpdatedAt: string): Promise<ReviewOutcome> {
  const rows = await db
    .update(src)
    .set({ reviewedAt: sql`now()` })
    .where(and(eq(src.id, id), sql`date_trunc(${MS}, ${src.updatedAt}) = ${expectedUpdatedAt}::timestamptz`))
    .returning(evidenceColumns);
  if (rows[0]) return { status: "ok", evidence: toStoredEvidence(rows[0]) };
  const exists = await db.select({ id: src.id }).from(src).where(eq(src.id, id));
  return exists.length > 0 ? { status: "stale" } : { status: "not_found" };
}

export type ReplaceSkillsOutcome =
  | { status: "ok"; evidence: StoredEvidence }
  | { status: "not_found" }
  | { status: "missing_skills"; missing: number[] };

// Replaces the complete set of skills linked to a source, in one transaction:
//  1. lock the source row (FOR UPDATE), so replacements of the same source run
//     one after another and a concurrent delete of the source waits or wins;
//  2. lock the requested skills (FOR KEY SHARE, ascending id), so none of them
//     can be deleted before commit; any that no longer exist are reported;
//  3. delete links not in the set, insert the missing ones.
// Nothing is written before both checks pass, and any error rolls back the
// whole replacement. Neither parent row is modified.
export async function replaceEvidenceSkills(id: number, skillIds: number[]): Promise<ReplaceSkillsOutcome> {
  return db.transaction(async (tx) => {
    const locked = await tx.select({ id: src.id }).from(src).where(eq(src.id, id)).for("update");
    if (locked.length === 0) return { status: "not_found" } as const;

    if (skillIds.length > 0) {
      const found = await tx
        .select({ id: candidateSkill.id })
        .from(candidateSkill)
        .where(inArray(candidateSkill.id, skillIds))
        .orderBy(asc(candidateSkill.id))
        .for("key share");
      const existing = new Set(found.map((r) => r.id));
      const missing = skillIds.filter((skillId) => !existing.has(skillId));
      if (missing.length > 0) return { status: "missing_skills", missing } as const;
    }

    await tx
      .delete(link)
      .where(
        skillIds.length > 0
          ? and(eq(link.evidenceSourceId, id), notInArray(link.skillId, skillIds))
          : eq(link.evidenceSourceId, id)
      );
    if (skillIds.length > 0) {
      await tx
        .insert(link)
        .values(skillIds.map((skillId) => ({ skillId, evidenceSourceId: id })))
        .onConflictDoNothing();
    }

    const [row] = await tx.select(evidenceColumns).from(src).where(eq(src.id, id));
    return { status: "ok", evidence: toStoredEvidence(row) } as const;
  });
}
