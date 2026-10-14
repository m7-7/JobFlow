import { eq, sql } from "drizzle-orm";
import { db } from "./db.js";
import { candidateProfile } from "./schema.js";
import type { ProfileInput, WorkModel } from "./profile-validation.js";

// Persistence for the singleton candidate profile. The id is always fixed
// here and never taken from the client.
const PROFILE_ID = 1;

export interface StoredProfile extends ProfileInput {
  updatedAt: Date;
}

type ProfileRow = typeof candidateProfile.$inferSelect;

// Map a row to the API shape: editable fields + updatedAt, no id.
function toStoredProfile(row: ProfileRow): StoredProfile {
  return {
    headline: row.headline,
    experienceSummary: row.experienceSummary,
    location: row.location,
    targetRoles: row.targetRoles,
    workModel: row.workModel as WorkModel | null,
    careerInstructions: row.careerInstructions,
    updatedAt: row.updatedAt,
  };
}

export async function getProfile(): Promise<StoredProfile | null> {
  const rows = await db
    .select()
    .from(candidateProfile)
    .where(eq(candidateProfile.id, PROFILE_ID))
    .limit(1);
  return rows[0] ? toStoredProfile(rows[0]) : null;
}

// Single atomic statement: INSERT ... ON CONFLICT (id) DO UPDATE ... RETURNING.
// Concurrent first saves cannot create a second row or fail with a duplicate
// key; the primary key arbitrates and the losing insert becomes an update.
// updated_at is set explicitly on both paths (the column default only applies
// to inserts).
export async function saveProfile(input: ProfileInput): Promise<StoredProfile> {
  const values = { ...input, updatedAt: sql`now()` };
  const [row] = await db
    .insert(candidateProfile)
    .values({ id: PROFILE_ID, ...values })
    .onConflictDoUpdate({ target: candidateProfile.id, set: values })
    .returning();
  return toStoredProfile(row);
}
