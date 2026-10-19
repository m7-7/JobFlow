import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { useDisposableTestDatabase } from "./helpers.js";

// Database-level tests for candidate_skill (migration 0001). They create their
// own database on the disposable server named by TEST_DATABASE_URL, so they can
// start from an empty schema, apply 0000 and 0001 separately, and run alongside
// the API tests, which migrate the TEST_DATABASE_URL database itself.
useDisposableTestDatabase();

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const serverUrl = new URL(process.env.TEST_DATABASE_URL!);
const dbName = `${serverUrl.pathname.slice(1)}_skill_${process.pid}_test`;
const dbUrl = new URL(serverUrl);
dbUrl.pathname = `/${dbName}`;

const admin = postgres(serverUrl.href, { max: 1, onnotice: () => {} });
let sql: postgres.Sql;
let tmpMigrations = "";

type Row = Record<string, unknown>;

// A copy of the migrations folder whose journal stops after 0000, to set up a
// database as it was before Step 2.3A.
async function migrationsThrough0000(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "jobflow-migrations-"));
  await cp(migrationsFolder, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: { tag: string }) => e.tag.startsWith("0000_"));
  await writeFile(journalPath, JSON.stringify(journal));
  return dir;
}

async function profileStructure() {
  const columns = await sql`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'candidate_profile'
    ORDER BY ordinal_position`;
  const constraints = await sql`
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE conrelid = 'public.candidate_profile'::regclass
    ORDER BY conname`;
  const indexes = await sql`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'candidate_profile'
    ORDER BY indexname`;
  return { columns: [...columns], constraints: [...constraints], indexes: [...indexes] };
}

function insert(row: Row) {
  return sql`INSERT INTO candidate_skill ${sql(row as Record<string, postgres.SerializableParameter>)} RETURNING *`;
}

async function assertRejected(row: Row, code: string, constraint?: string | RegExp) {
  await assert.rejects(insert(row), (err: postgres.PostgresError) => {
    assert.equal(err.code, code, `expected SQLSTATE ${code}, got ${err.code}: ${err.message}`);
    if (typeof constraint === "string") assert.equal(err.constraint_name, constraint);
    else if (constraint) assert.match(err.constraint_name ?? "", constraint);
    return true;
  });
}

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const NOT_NULL_VIOLATION = "23502";
const STRING_TOO_LONG = "22001";

before(async () => {
  await admin`DROP DATABASE IF EXISTS ${admin(dbName)}`;
  await admin`CREATE DATABASE ${admin(dbName)}`;
  sql = postgres(dbUrl.href, { max: 1, onnotice: () => {} });
  tmpMigrations = await migrationsThrough0000();
});

after(async () => {
  await sql?.end();
  await admin`DROP DATABASE IF EXISTS ${admin(dbName)}`;
  await admin.end();
  if (tmpMigrations) await rm(tmpMigrations, { recursive: true, force: true });
});

describe("migration 0001", () => {
  it("contains no ALTER or DROP statements and does not touch candidate_profile", async () => {
    const text = await readFile(path.join(migrationsFolder, "0001_candidate_skill.sql"), "utf8");
    assert.doesNotMatch(text, /\b(ALTER|DROP)\b/i);
    assert.doesNotMatch(text, /candidate_profile/);
  });

  it("upgrades a 0000 database with a saved profile without changing it", async () => {
    // Separate client: drizzle() replaces the JSON serializers of the client it wraps.
    const migrationClient = postgres(dbUrl.href, { max: 1, onnotice: () => {} });
    after(() => migrationClient.end());
    const db = drizzle(migrationClient);
    await migrate(db, { migrationsFolder: tmpMigrations });
    await sql`
      INSERT INTO candidate_profile (headline, experience_summary, location, target_roles, work_model, career_instructions)
      VALUES ('Fixture headline', 'Fixture summary', 'Fixture city', ${sql.json(["Role A", "Role B"])}, 'hybrid', 'Fixture instructions')`;
    const profileBefore = await sql`SELECT * FROM candidate_profile`;
    const structureBefore = await profileStructure();
    assert.equal((await sql`SELECT to_regclass('public.candidate_skill') AS t`)[0].t, null);

    await migrate(db, { migrationsFolder });

    assert.deepEqual([...(await sql`SELECT * FROM candidate_profile`)], [...profileBefore]);
    assert.deepEqual(await profileStructure(), structureBefore);
    assert.equal((await sql`SELECT to_regclass('public.candidate_skill') AS t`)[0].t, "candidate_skill");
    assert.equal((await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)[0].n, 2);

    // Re-running is a no-op.
    await migrate(db, { migrationsFolder });
    assert.equal((await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)[0].n, 2);
  });
});

// Runs after "migration 0001" (node:test runs suites in order), which created the table.
describe("candidate_skill constraints", () => {
  beforeEach(async () => {
    await sql`DELETE FROM candidate_skill`;
  });

  it("accepts a name alone and fills the defaults", async () => {
    const [row] = await insert({ name: "TypeScript" });
    assert.equal(typeof row.id, "number");
    assert.equal(row.name, "TypeScript");
    assert.deepEqual(row.experience_contexts, []);
    for (const column of ["practical_confidence", "interview_confidence", "experience_months", "last_used_year", "notes"]) {
      assert.equal(row[column], null, column);
    }
    assert.ok(row.created_at instanceof Date);
    assert.ok(row.updated_at instanceof Date);
  });

  it("generates integer identity ids and rejects explicit ones", async () => {
    const [a] = await insert({ name: "A" });
    const [b] = await insert({ name: "B" });
    assert.ok(Number.isInteger(a.id) && Number.isInteger(b.id));
    assert.ok((b.id as number) > (a.id as number));
    await assert.rejects(insert({ id: 999, name: "C" }), { code: "428C9" });
  });

  it("accepts every field at once", async () => {
    const [row] = await insert({
      name: "PostgreSQL",
      experience_contexts: sql.json(["professional", "personal_project", "academic", "learning"]),
      practical_confidence: 4,
      interview_confidence: 3,
      experience_months: 36,
      last_used_year: 2026,
      notes: "Fixture note",
    });
    assert.deepEqual(row.experience_contexts, ["professional", "personal_project", "academic", "learning"]);
    assert.equal(row.practical_confidence, 4);
    assert.equal(row.interview_confidence, 3);
    assert.equal(row.experience_months, 36);
    assert.equal(row.last_used_year, 2026);
    assert.equal(row.notes, "Fixture note");
  });

  describe("name", () => {
    it("is stored exactly as entered", async () => {
      for (const name of ["TypeScript", "node.JS", "C#", "  Spaced  Out  "]) {
        const [row] = await insert({ name });
        assert.equal(row.name, name);
      }
    });

    it("allows 100 characters (not bytes) and rejects 101", async () => {
      await insert({ name: "a".repeat(100) });
      await insert({ name: "é".repeat(100) });
      await assertRejected({ name: "b".repeat(101) }, STRING_TOO_LONG);
    });

    it("rejects null and blank names", async () => {
      await assertRejected({ name: null }, NOT_NULL_VIOLATION);
      for (const name of ["", " ", "   ", "\t", "\n", "\r\n", "\f", "\v", " \t\n\r\f\v "]) {
        await assertRejected({ name }, CHECK_VIOLATION, "candidate_skill_name_not_blank");
      }
    });

    it("is unique ignoring case and leading, trailing and repeated ASCII whitespace", async () => {
      await insert({ name: "TypeScript" });
      for (const name of ["typescript", "TYPESCRIPT", "  TypeScript", "TypeScript ", "\tTypeScript\n", "\r\f\vtypeScript"]) {
        await assertRejected({ name }, UNIQUE_VIOLATION, "candidate_skill_name_normalized_unique");
      }

      await insert({ name: "Machine Learning" });
      for (const name of ["machine  learning", "Machine\tLearning", " MACHINE \n\r LEARNING "]) {
        await assertRejected({ name }, UNIQUE_VIOLATION, "candidate_skill_name_normalized_unique");
      }
    });

    it("keeps genuinely different names apart", async () => {
      await insert({ name: "TypeScript" });
      // Whitespace inside a name is collapsed, not removed.
      await insert({ name: "Type Script" });
      // Only ASCII whitespace is normalized; a no-break space is a different character.
      await insert({ name: "Type Script" });
      await insert({ name: "TypeScripts" });
    });

    it("enforces uniqueness on update too", async () => {
      await insert({ name: "Go" });
      const [rust] = await insert({ name: "Rust" });
      await assert.rejects(sql`UPDATE candidate_skill SET name = ' go ' WHERE id = ${rust.id as number}`, {
        code: UNIQUE_VIOLATION,
      });
      // Changing only the display form of the same skill is allowed.
      await sql`UPDATE candidate_skill SET name = 'RUST' WHERE id = ${rust.id as number}`;
    });
  });

  describe("experience_contexts", () => {
    it("accepts [], each allowed value, and any order of distinct values", async () => {
      const values = [[], ["professional"], ["personal_project"], ["academic"], ["learning"], ["learning", "professional"]];
      for (const [i, contexts] of values.entries()) {
        const [row] = await insert({ name: `Skill ${i}`, experience_contexts: sql.json(contexts) });
        assert.deepEqual(row.experience_contexts, contexts);
      }
    });

    it("rejects SQL null", async () => {
      await assertRejected({ name: "X", experience_contexts: null }, NOT_NULL_VIOLATION);
    });

    it("rejects values outside the allowed set", async () => {
      for (const contexts of [["work"], ["Professional"], ["professional", "hobby"], [1], [null], [["professional"]], [{}]]) {
        await assertRejected(
          { name: "X", experience_contexts: sql.json(contexts) },
          CHECK_VIOLATION,
          "candidate_skill_experience_contexts_allowed"
        );
      }
    });

    it("rejects duplicates", async () => {
      for (const contexts of [["professional", "professional"], ["academic", "learning", "academic"]]) {
        await assertRejected(
          { name: "X", experience_contexts: sql.json(contexts) },
          CHECK_VIOLATION,
          "candidate_skill_experience_contexts_unique"
        );
      }
    });

    it("rejects non-arrays", async () => {
      // A bare allowed string passes jsonb containment, so only the array check catches it.
      await assertRejected(
        { name: "X", experience_contexts: sql.json("professional") },
        CHECK_VIOLATION,
        "candidate_skill_experience_contexts_array"
      );
      for (const value of [{ professional: true }, {}, "work", 1, true]) {
        await assertRejected(
          { name: "X", experience_contexts: sql.json(value) },
          CHECK_VIOLATION,
          /^candidate_skill_experience_contexts_/
        );
      }
      // JSON null (sql.json(null) would send SQL NULL instead).
      await assert.rejects(sql`INSERT INTO candidate_skill (name, experience_contexts) VALUES ('X', 'null'::jsonb)`, {
        code: CHECK_VIOLATION,
      });
    });
  });

  describe("numeric ranges", () => {
    const ranges = [
      { column: "practical_confidence", min: 1, max: 5 },
      { column: "interview_confidence", min: 1, max: 5 },
      { column: "experience_months", min: 0, max: 1200 },
      { column: "last_used_year", min: 1950, max: 2100 },
    ];

    for (const { column, min, max } of ranges) {
      it(`${column}: accepts null, ${min} and ${max}; rejects ${min - 1} and ${max + 1}`, async () => {
        await insert({ name: "null", [column]: null });
        await insert({ name: "min", [column]: min });
        await insert({ name: "max", [column]: max });
        await assertRejected({ name: "below", [column]: min - 1 }, CHECK_VIOLATION, `candidate_skill_${column}_range`);
        await assertRejected({ name: "above", [column]: max + 1 }, CHECK_VIOLATION, `candidate_skill_${column}_range`);
      });
    }

    it("keeps practical and interview confidence independent", async () => {
      const [a] = await insert({ name: "A", practical_confidence: 5, interview_confidence: null });
      const [b] = await insert({ name: "B", practical_confidence: null, interview_confidence: 1 });
      const [c] = await insert({ name: "C", practical_confidence: 1, interview_confidence: 5 });
      assert.deepEqual([a.practical_confidence, a.interview_confidence], [5, null]);
      assert.deepEqual([b.practical_confidence, b.interview_confidence], [null, 1]);
      assert.deepEqual([c.practical_confidence, c.interview_confidence], [1, 5]);
    });
  });

  it("requires created_at and updated_at", async () => {
    await assertRejected({ name: "X", created_at: null }, NOT_NULL_VIOLATION);
    await assertRejected({ name: "X", updated_at: null }, NOT_NULL_VIOLATION);
  });
});
