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

// Database-level tests for candidate_evidence_source and candidate_skill_evidence
// (migration 0002). Like the skill schema tests, they create their own database
// on the disposable server named by TEST_DATABASE_URL, so they can start from a
// database migrated through 0001 and run alongside the other database tests.
useDisposableTestDatabase();

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const serverUrl = new URL(process.env.TEST_DATABASE_URL!);
const dbName = `${serverUrl.pathname.slice(1)}_evidence_${process.pid}_test`;
const dbUrl = new URL(serverUrl);
dbUrl.pathname = `/${dbName}`;

const admin = postgres(serverUrl.href, { max: 1, onnotice: () => {} });
let sql: postgres.Sql;
let tmpMigrations = "";

type Row = Record<string, unknown>;

const SOURCE_TYPES = ["professional_experience", "personal_project", "cv", "portfolio", "other"];

// A copy of the migrations folder whose journal stops after 0001, to set up a
// database as it was before Step 2.4B.
async function migrationsThrough0001(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "jobflow-migrations-"));
  await cp(migrationsFolder, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: { tag: string }) => /^000[01]_/.test(e.tag));
  await writeFile(journalPath, JSON.stringify(journal));
  return dir;
}

async function tableStructure(table: string) {
  const columns = await sql`
    SELECT column_name, data_type, character_maximum_length, is_nullable, column_default, is_identity, identity_generation
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
    ORDER BY ordinal_position`;
  const constraints = await sql`
    SELECT conname, contype, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE conrelid = ${`public.${table}`}::regclass
    ORDER BY conname`;
  const indexes = await sql`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = ${table}
    ORDER BY indexname`;
  return { columns: [...columns], constraints: [...constraints], indexes: [...indexes] };
}

async function migrationCount(): Promise<number> {
  return (await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)[0].n;
}

function insertSource(row: Row) {
  return sql`INSERT INTO candidate_evidence_source ${sql(row as Record<string, postgres.SerializableParameter>)} RETURNING *`;
}

async function source(title = "Fixture source", type = "other"): Promise<number> {
  const [row] = await insertSource({ type, title });
  return row.id as number;
}

async function skill(name: string): Promise<number> {
  const [row] = await sql`INSERT INTO candidate_skill (name) VALUES (${name}) RETURNING id`;
  return row.id as number;
}

function link(skillId: number, sourceId: number) {
  return sql`INSERT INTO candidate_skill_evidence (skill_id, evidence_source_id) VALUES (${skillId}, ${sourceId})`;
}

async function links(): Promise<[number, number][]> {
  const rows = await sql`SELECT skill_id, evidence_source_id FROM candidate_skill_evidence ORDER BY 1, 2`;
  return rows.map((r) => [r.skill_id as number, r.evidence_source_id as number]);
}

async function ids(table: "candidate_skill" | "candidate_evidence_source"): Promise<number[]> {
  return (await sql`SELECT id FROM ${sql(table)} ORDER BY id`).map((r) => r.id as number);
}

async function assertRejected(query: Promise<unknown>, code: string, constraint?: string) {
  await assert.rejects(query, (err: postgres.PostgresError) => {
    assert.equal(err.code, code, `expected SQLSTATE ${code}, got ${err.code}: ${err.message}`);
    if (constraint) assert.equal(err.constraint_name, constraint);
    return true;
  });
}

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const NOT_NULL_VIOLATION = "23502";
const FOREIGN_KEY_VIOLATION = "23503";
const STRING_TOO_LONG = "22001";
const GENERATED_ALWAYS = "428C9";

before(async () => {
  await admin`DROP DATABASE IF EXISTS ${admin(dbName)}`;
  await admin`CREATE DATABASE ${admin(dbName)}`;
  sql = postgres(dbUrl.href, { max: 1, onnotice: () => {} });
  tmpMigrations = await migrationsThrough0001();
});

after(async () => {
  await sql?.end();
  await admin`DROP DATABASE IF EXISTS ${admin(dbName)}`;
  await admin.end();
  if (tmpMigrations) await rm(tmpMigrations, { recursive: true, force: true });
});

describe("migration 0002", () => {
  it("only creates the two evidence tables, their junction foreign keys and index", async () => {
    const text = await readFile(path.join(migrationsFolder, "0002_candidate_evidence.sql"), "utf8");
    assert.doesNotMatch(text, /\b(DROP|TRUNCATE|INSERT)\b/i);
    assert.doesNotMatch(text, /candidate_profile/);
    const statements = text.split("--> statement-breakpoint").map((s) => s.trim());
    const allowed = [
      /^CREATE TABLE "candidate_evidence_source" \(/,
      /^CREATE TABLE "candidate_skill_evidence" \(/,
      // candidate_skill appears only as a foreign key target.
      /^ALTER TABLE "candidate_skill_evidence" ADD CONSTRAINT "candidate_skill_evidence_skill_fk" FOREIGN KEY \("skill_id"\) REFERENCES "public"\."candidate_skill"\("id"\) ON DELETE cascade ON UPDATE no action;$/,
      /^ALTER TABLE "candidate_skill_evidence" ADD CONSTRAINT "candidate_skill_evidence_source_fk" FOREIGN KEY \("evidence_source_id"\) REFERENCES "public"\."candidate_evidence_source"\("id"\) ON DELETE cascade ON UPDATE no action;$/,
      /^CREATE INDEX "candidate_skill_evidence_source_idx" ON "candidate_skill_evidence" USING btree \("evidence_source_id"\);$/,
    ];
    assert.equal(statements.length, allowed.length);
    statements.forEach((statement, i) => assert.match(statement, allowed[i]));
  });

  it("upgrades a 0001 database with a saved profile and skills without changing them", async () => {
    // Separate client: drizzle() replaces the JSON serializers of the client it wraps.
    const migrationClient = postgres(dbUrl.href, { max: 1, onnotice: () => {} });
    after(() => migrationClient.end());
    const db = drizzle(migrationClient);
    await migrate(db, { migrationsFolder: tmpMigrations });
    assert.equal(await migrationCount(), 2);

    await sql`
      INSERT INTO candidate_profile (headline, experience_summary, location, target_roles, work_model, career_instructions)
      VALUES ('Fixture headline', 'Fixture summary', 'Fixture city', ${sql.json(["Role A", "Role B"])}, 'hybrid', 'Fixture instructions')`;
    await sql`
      INSERT INTO candidate_skill (name, experience_contexts, practical_confidence, interview_confidence, experience_months, last_used_year, notes)
      VALUES ('TypeScript', ${sql.json(["professional", "learning"])}, 4, 3, 36, 2026, 'Fixture note'),
             ('PostgreSQL', '[]'::jsonb, NULL, NULL, NULL, NULL, NULL)`;
    const profileBefore = [...(await sql`SELECT * FROM candidate_profile`)];
    const skillsBefore = [...(await sql`SELECT * FROM candidate_skill ORDER BY id`)];
    const profileStructureBefore = await tableStructure("candidate_profile");
    const skillStructureBefore = await tableStructure("candidate_skill");
    for (const table of ["candidate_evidence_source", "candidate_skill_evidence"]) {
      assert.equal((await sql`SELECT to_regclass(${`public.${table}`}) AS t`)[0].t, null);
    }

    await migrate(db, { migrationsFolder });

    assert.equal(await migrationCount(), 3);
    assert.deepEqual([...(await sql`SELECT * FROM candidate_profile`)], profileBefore);
    assert.deepEqual([...(await sql`SELECT * FROM candidate_skill ORDER BY id`)], skillsBefore);
    assert.deepEqual(await tableStructure("candidate_profile"), profileStructureBefore);
    assert.deepEqual(await tableStructure("candidate_skill"), skillStructureBefore);

    const sourceStructure = await tableStructure("candidate_evidence_source");
    assert.deepEqual(
      sourceStructure.columns.map((c) => c.column_name),
      ["id", "type", "title", "description", "url", "origin", "reviewed_at", "created_at", "updated_at"]
    );
    assert.deepEqual(
      sourceStructure.constraints.map((c) => [c.conname, c.contype]),
      [
        ["candidate_evidence_source_origin_allowed", "c"],
        ["candidate_evidence_source_pkey", "p"],
        ["candidate_evidence_source_title_not_blank", "c"],
        ["candidate_evidence_source_type_allowed", "c"],
        ["candidate_evidence_source_url_http", "c"],
      ]
    );

    const junctionStructure = await tableStructure("candidate_skill_evidence");
    assert.deepEqual(
      junctionStructure.columns.map((c) => [c.column_name, c.data_type, c.is_nullable]),
      [
        ["skill_id", "integer", "NO"],
        ["evidence_source_id", "integer", "NO"],
      ]
    );
    assert.deepEqual(
      junctionStructure.constraints.map((c) => [c.conname, c.def]),
      [
        ["candidate_skill_evidence_pk", "PRIMARY KEY (skill_id, evidence_source_id)"],
        [
          "candidate_skill_evidence_skill_fk",
          "FOREIGN KEY (skill_id) REFERENCES candidate_skill(id) ON DELETE CASCADE",
        ],
        [
          "candidate_skill_evidence_source_fk",
          "FOREIGN KEY (evidence_source_id) REFERENCES candidate_evidence_source(id) ON DELETE CASCADE",
        ],
      ]
    );
    assert.deepEqual(
      junctionStructure.indexes.map((i) => i.indexname),
      ["candidate_skill_evidence_pk", "candidate_skill_evidence_source_idx"]
    );
    assert.match(
      junctionStructure.indexes[1].indexdef as string,
      /USING btree \(evidence_source_id\)$/
    );

    // Re-running is a no-op.
    await migrate(db, { migrationsFolder });
    assert.equal(await migrationCount(), 3);
    assert.deepEqual([...(await sql`SELECT * FROM candidate_skill ORDER BY id`)], skillsBefore);
    assert.deepEqual(await tableStructure("candidate_skill_evidence"), junctionStructure);
  });
});

// Runs after "migration 0002" (node:test runs suites in order), which created the tables.
describe("candidate_evidence_source constraints", () => {
  beforeEach(async () => {
    await sql`DELETE FROM candidate_skill_evidence`;
    await sql`DELETE FROM candidate_evidence_source`;
  });

  it("accepts a type and title alone and fills the defaults", async () => {
    const [row] = await insertSource({ type: "cv", title: "CV 2026" });
    assert.equal(row.type, "cv");
    assert.equal(row.title, "CV 2026");
    assert.equal(row.description, null);
    assert.equal(row.url, null);
    assert.equal(row.origin, "manual");
    assert.equal(row.reviewed_at, null);
    assert.ok(row.created_at instanceof Date);
    assert.ok(row.updated_at instanceof Date);
  });

  it("generates integer identity ids and rejects explicit ones", async () => {
    const a = await source("A");
    const b = await source("B");
    assert.ok(Number.isInteger(a) && Number.isInteger(b));
    assert.ok(b > a);
    await assertRejected(insertSource({ id: 999, type: "other", title: "C" }), GENERATED_ALWAYS);
  });

  it("accepts every field at once", async () => {
    const reviewedAt = new Date("2026-10-01T12:00:00Z");
    const [row] = await insertSource({
      type: "portfolio",
      title: "Fixture portfolio",
      description: "Fixture description",
      url: "https://example.com/portfolio",
      origin: "manual",
      reviewed_at: reviewedAt,
    });
    assert.equal(row.description, "Fixture description");
    assert.equal(row.url, "https://example.com/portfolio");
    assert.deepEqual(row.reviewed_at, reviewedAt);
  });

  describe("type", () => {
    it("accepts every approved type", async () => {
      for (const type of SOURCE_TYPES) {
        const [row] = await insertSource({ type, title: type });
        assert.equal(row.type, type);
      }
    });

    it("rejects null and anything else", async () => {
      await assertRejected(insertSource({ type: null, title: "X" }), NOT_NULL_VIOLATION);
      for (const type of ["", "CV", "Portfolio", " cv", "cv ", "project", "github", "professional"]) {
        await assertRejected(insertSource({ type, title: "X" }), CHECK_VIOLATION, "candidate_evidence_source_type_allowed");
      }
    });
  });

  describe("title", () => {
    it("is stored exactly as entered", async () => {
      for (const title of ["x", "  Spaced  Out  ", "Ünïcödé"]) {
        const [row] = await insertSource({ type: "other", title });
        assert.equal(row.title, title);
      }
    });

    it("allows 200 characters (not bytes) and rejects 201", async () => {
      await insertSource({ type: "other", title: "a".repeat(200) });
      await insertSource({ type: "other", title: "é".repeat(200) });
      await assertRejected(insertSource({ type: "other", title: "b".repeat(201) }), STRING_TOO_LONG);
    });

    it("rejects null and blank titles", async () => {
      await assertRejected(insertSource({ type: "other", title: null }), NOT_NULL_VIOLATION);
      for (const title of ["", " ", "   ", "\t", "\n", "\r\n", "\f", "\v", " \t\n\r\f\v "]) {
        await assertRejected(insertSource({ type: "other", title }), CHECK_VIOLATION, "candidate_evidence_source_title_not_blank");
      }
    });

    it("is not unique", async () => {
      await source("Same title");
      await source("Same title");
    });
  });

  describe("url", () => {
    it("accepts http and https in any case", async () => {
      for (const url of ["http://example.com", "https://example.com/a?b=c#d", "HTTP://EXAMPLE.COM", "Https://example.com"]) {
        const [row] = await insertSource({ type: "other", title: "X", url });
        assert.equal(row.url, url);
      }
    });

    it("allows 2048 characters and rejects 2049", async () => {
      const prefix = "https://example.com/";
      await insertSource({ type: "other", title: "X", url: prefix + "a".repeat(2048 - prefix.length) });
      await assertRejected(insertSource({ type: "other", title: "X", url: prefix + "a".repeat(2049 - prefix.length) }), STRING_TOO_LONG);
    });

    it("rejects other schemes and scheme-less values", async () => {
      for (const url of [
        "",
        "example.com",
        "//example.com",
        "ftp://example.com",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "mailto:a@example.com",
        "data:text/html,x",
        "http:example.com",
        "https:/example.com",
        " https://example.com",
        "httpx://example.com",
      ]) {
        await assertRejected(insertSource({ type: "other", title: "X", url }), CHECK_VIOLATION, "candidate_evidence_source_url_http");
      }
    });
  });

  it("rejects any origin other than manual", async () => {
    await assertRejected(insertSource({ type: "other", title: "X", origin: null }), NOT_NULL_VIOLATION);
    for (const origin of ["", "Manual", "github", "ai", "import", "verified"]) {
      await assertRejected(insertSource({ type: "other", title: "X", origin }), CHECK_VIOLATION, "candidate_evidence_source_origin_allowed");
    }
  });

  it("requires created_at and updated_at", async () => {
    await assertRejected(insertSource({ type: "other", title: "X", created_at: null }), NOT_NULL_VIOLATION);
    await assertRejected(insertSource({ type: "other", title: "X", updated_at: null }), NOT_NULL_VIOLATION);
  });
});

describe("candidate_skill_evidence", () => {
  let skillA: number;
  let skillB: number;
  let sourceX: number;
  let sourceY: number;

  beforeEach(async () => {
    await sql`DELETE FROM candidate_skill_evidence`;
    await sql`DELETE FROM candidate_evidence_source`;
    await sql`DELETE FROM candidate_skill`;
    skillA = await skill("Skill A");
    skillB = await skill("Skill B");
    sourceX = await source("Source X");
    sourceY = await source("Source Y");
  });

  it("allows sources and skills without links", async () => {
    assert.deepEqual(await links(), []);
    assert.equal((await ids("candidate_skill")).length, 2);
    assert.equal((await ids("candidate_evidence_source")).length, 2);
  });

  it("links one source to several skills and one skill to several sources", async () => {
    await link(skillA, sourceX);
    await link(skillB, sourceX);
    await link(skillA, sourceY);
    assert.deepEqual(await links(), [
      [skillA, sourceX],
      [skillA, sourceY],
      [skillB, sourceX],
    ]);
  });

  it("rejects duplicate pairs", async () => {
    await link(skillA, sourceX);
    await assertRejected(link(skillA, sourceX), UNIQUE_VIOLATION, "candidate_skill_evidence_pk");
  });

  it("rejects null and missing references", async () => {
    await assertRejected(sql`INSERT INTO candidate_skill_evidence (skill_id, evidence_source_id) VALUES (NULL, ${sourceX})`, NOT_NULL_VIOLATION);
    await assertRejected(sql`INSERT INTO candidate_skill_evidence (skill_id, evidence_source_id) VALUES (${skillA}, NULL)`, NOT_NULL_VIOLATION);
    await assertRejected(link(999999, sourceX), FOREIGN_KEY_VIOLATION, "candidate_skill_evidence_skill_fk");
    await assertRejected(link(skillA, 999999), FOREIGN_KEY_VIOLATION, "candidate_skill_evidence_source_fk");
    assert.deepEqual(await links(), []);
  });

  it("deleting a skill removes only its links", async () => {
    await link(skillA, sourceX);
    await link(skillA, sourceY);
    await link(skillB, sourceX);
    await sql`DELETE FROM candidate_skill WHERE id = ${skillA}`;
    assert.deepEqual(await links(), [[skillB, sourceX]]);
    assert.deepEqual(await ids("candidate_skill"), [skillB]);
    assert.deepEqual(await ids("candidate_evidence_source"), [sourceX, sourceY]);
  });

  it("deleting an evidence source removes only its links", async () => {
    await link(skillA, sourceX);
    await link(skillA, sourceY);
    await link(skillB, sourceX);
    await sql`DELETE FROM candidate_evidence_source WHERE id = ${sourceX}`;
    assert.deepEqual(await links(), [[skillA, sourceY]]);
    assert.deepEqual(await ids("candidate_skill"), [skillA, skillB]);
    assert.deepEqual(await ids("candidate_evidence_source"), [sourceY]);
  });

  it("deleting a link keeps both the skill and the source", async () => {
    await link(skillA, sourceX);
    await link(skillB, sourceX);
    await sql`DELETE FROM candidate_skill_evidence WHERE skill_id = ${skillA} AND evidence_source_id = ${sourceX}`;
    assert.deepEqual(await links(), [[skillB, sourceX]]);
    assert.deepEqual(await ids("candidate_skill"), [skillA, skillB]);
    assert.deepEqual(await ids("candidate_evidence_source"), [sourceX, sourceY]);
  });
});
