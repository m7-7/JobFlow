import { pgTable, smallint, integer, varchar, text, jsonb, timestamp, check, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Single-user application: exactly one candidate profile row can ever exist,
// pinned to id = 1 by the primary key default and the CHECK constraint below.
// No row is seeded by migration — Step 2.2B creates it lazily on first save.
export const candidateProfile = pgTable(
  "candidate_profile",
  {
    id: smallint("id").primaryKey().default(1),

    // Factual information — user-entered, not verified. Nullable so the
    // profile can be completed gradually.
    headline: text("headline"),
    experienceSummary: text("experience_summary"),
    location: text("location"),

    // Structured preferences
    targetRoles: jsonb("target_roles").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    workModel: text("work_model"),

    // Free-text career instructions. Kept separate from the factual fields
    // above: it must never be auto-promoted into a factual attribute.
    careerInstructions: text("career_instructions"),

    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("candidate_profile_singleton", sql`${table.id} = 1`),
    check(
      "candidate_profile_work_model_allowed",
      sql`${table.workModel} IS NULL OR ${table.workModel} IN ('remote', 'hybrid', 'onsite', 'flexible')`
    ),
  ]
);

export const EXPERIENCE_CONTEXTS = ["professional", "personal_project", "academic", "learning"] as const;
export type ExperienceContext = (typeof EXPERIENCE_CONTEXTS)[number];

// The candidate's skills. Standalone: not linked to candidate_profile.
export const candidateSkill = pgTable(
  "candidate_skill",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    // Stored exactly as entered, so display capitalization is preserved.
    // Uniqueness is enforced on a normalized form by the index below.
    name: varchar("name", { length: 100 }).notNull(),

    // Where the skill was used. A set of EXPERIENCE_CONTEXTS values; [] = unspecified.
    experienceContexts: jsonb("experience_contexts")
      .$type<ExperienceContext[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    // Self-assessed, 1–5. Independent: confidence in using a skill and in
    // discussing it in an interview can differ.
    practicalConfidence: smallint("practical_confidence"),
    interviewConfidence: smallint("interview_confidence"),

    experienceMonths: smallint("experience_months"),
    lastUsedYear: smallint("last_used_year"),
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // "TypeScript", " typescript " and "Type\t\tScript" collide: case is ignored,
    // and runs of ASCII whitespace (tab, line feed, vertical tab, form feed,
    // carriage return, space) are collapsed to one space and trimmed.
    uniqueIndex("candidate_skill_name_normalized_unique").on(
      sql`lower(btrim(regexp_replace(${table.name}, '[\\t\\n\\v\\f\\r ]+', ' ', 'g')))`
    ),
    check("candidate_skill_name_not_blank", sql`${table.name} ~ '[^\\t\\n\\v\\f\\r ]'`),
    check("candidate_skill_experience_contexts_array", sql`jsonb_typeof(${table.experienceContexts}) = 'array'`),
    check(
      "candidate_skill_experience_contexts_allowed",
      sql`${table.experienceContexts} <@ '["professional", "personal_project", "academic", "learning"]'::jsonb`
    ),
    // With every element allowed, the array is duplicate-free exactly when its
    // length equals the number of distinct allowed values it contains. The CASE
    // keeps jsonb_array_length away from non-arrays (rejected by the check above).
    check(
      "candidate_skill_experience_contexts_unique",
      sql`CASE WHEN jsonb_typeof(${table.experienceContexts}) = 'array' THEN
        jsonb_array_length(${table.experienceContexts}) =
          (${table.experienceContexts} @> '["professional"]')::int +
          (${table.experienceContexts} @> '["personal_project"]')::int +
          (${table.experienceContexts} @> '["academic"]')::int +
          (${table.experienceContexts} @> '["learning"]')::int
      ELSE true END`
    ),
    check(
      "candidate_skill_practical_confidence_range",
      sql`${table.practicalConfidence} IS NULL OR ${table.practicalConfidence} BETWEEN 1 AND 5`
    ),
    check(
      "candidate_skill_interview_confidence_range",
      sql`${table.interviewConfidence} IS NULL OR ${table.interviewConfidence} BETWEEN 1 AND 5`
    ),
    check(
      "candidate_skill_experience_months_range",
      sql`${table.experienceMonths} IS NULL OR ${table.experienceMonths} BETWEEN 0 AND 1200`
    ),
    check(
      "candidate_skill_last_used_year_range",
      sql`${table.lastUsedYear} IS NULL OR ${table.lastUsedYear} BETWEEN 1950 AND 2100`
    ),
  ]
);
