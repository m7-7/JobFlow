import { pgTable, smallint, text, jsonb, timestamp, check } from "drizzle-orm/pg-core";
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
