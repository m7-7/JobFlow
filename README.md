# JobFlow

Self-hosted Job Search Automation application.

**Stack:** React + TypeScript frontend · Node.js + TypeScript backend · Drizzle ORM · PostgreSQL · Docker Compose

---

## Prerequisites

| Tool | Minimum version |
|------|----------------|
| [Docker](https://docs.docker.com/get-docker/) | 24+ |
| Docker Compose (included with Docker Desktop) | v2 |
| [Node.js](https://nodejs.org/) | 22 (local dev only); 22.18+ to run the frontend unit tests |
| [npm](https://www.npmjs.com/) | 10 (local dev only) |

---

## Repository structure

```
JobFlow/
├── frontend/          # React + TypeScript + Vite
│   ├── src/           # Application source
│   ├── vite.config.ts
│   └── Dockerfile
├── backend/           # Node.js + TypeScript + Express
│   ├── src/
│   │   ├── index.ts               # HTTP server entry point (listen only)
│   │   ├── app.ts                 # Express app: middleware, routes, error handler
│   │   ├── errors.ts              # Safe error responses (400/413/503/500), duplicate-key detection
│   │   ├── profile-routes.ts      # GET/PUT /profile (HTTP layer)
│   │   ├── profile-validation.ts  # Profile validation and normalization rules
│   │   ├── profile-store.ts       # Profile persistence (Drizzle)
│   │   ├── skill-routes.ts        # GET/POST /skills, PUT/DELETE /skills/:id (HTTP layer)
│   │   ├── skill-validation.ts    # Skill validation and normalization rules
│   │   ├── skill-store.ts         # Skill persistence (Drizzle)
│   │   ├── db.ts                  # Drizzle client initialisation
│   │   └── schema.ts              # Database schema (candidate_profile, candidate_skill)
│   ├── test/                      # node:test unit + integration tests
│   ├── drizzle.config.ts
│   └── Dockerfile
├── docker-compose.yml
├── .env.example       # Safe placeholder values — copy to .env
└── .gitignore
```

---

## Environment setup

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

2. Open `.env` and set a real password for `POSTGRES_PASSWORD`, and use the same password in `DATABASE_URL`:
   ```dotenv
   POSTGRES_PASSWORD=your_secure_password_here
   DATABASE_URL=postgresql://jobflow:your_secure_password_here@localhost:5433/jobflow
   ```

   > `.env` is listed in `.gitignore` and must never be committed.

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `POSTGRES_USER` | No (default: `jobflow`) | PostgreSQL username |
| `POSTGRES_PASSWORD` | **Yes** | PostgreSQL password — set a real value |
| `POSTGRES_DB` | No (default: `jobflow`) | PostgreSQL database name |
| `DATABASE_URL` | Host-side commands only | Connection string for commands run directly on the host (backend without Docker, `drizzle-kit`). Hostname `localhost`. Not used by Docker Compose. |

### Database hostname: Compose vs. host

| Where the code runs | Hostname | Where `DATABASE_URL` comes from |
|---------------------|----------|---------------------------------|
| Backend container (Docker Compose) | `postgres` (Compose service name) | Built by `docker-compose.yml` from `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`. The `DATABASE_URL` line in `.env` is ignored. |
| Commands on the host | `localhost` (container port 5432 is published to `127.0.0.1:5433`) | `DATABASE_URL` in `.env`, exported into your shell (see below). |

> Database credentials never reach the frontend. `DATABASE_URL` is a backend-only variable, and the frontend container receives only `BACKEND_PROXY_TARGET`.

---

## Start the development environment

```bash
docker compose up --build
```

This starts three services:

| Service | Container port | Host port |
|---------|---------------|-----------|
| PostgreSQL | 5432 | 127.0.0.1:5433 |
| Backend (Node/Express) | 3001 | 127.0.0.1:3001 |
| Frontend (Vite dev server) | 5173 | 127.0.0.1:5173 |

> PostgreSQL is published on host port **5433**, not 5432, so it does not collide with a natively installed PostgreSQL on `localhost:5432`. Inside the Compose network the backend still connects to `postgres:5432`.

The backend waits for PostgreSQL to pass its health check before starting.

> **Local development only.** All published ports are bound to `127.0.0.1`, so the stack is reachable only from this machine. This Compose file is not a remote or production deployment setup.

Dependencies are installed with `npm ci` from the committed lockfiles. Source files are copied into the images at build time, so run `docker compose up --build` after changing code or dependencies.

---

## Local URLs

| Service | URL |
|---------|-----|
| Frontend | http://localhost:5173 |
| Backend health endpoint | http://localhost:3001/health |

---

## Verify the stack

**Frontend → Backend → PostgreSQL (one command):**

Open http://localhost:5173 in a browser. The status page shows three rows:

- **Frontend** — always green (React is running)
- **Backend** — green when `/api/health` returns a valid health response; red "Backend unreachable" otherwise
- **PostgreSQL** — green when Drizzle successfully executes `SELECT 1`; red "Database unavailable" when the backend reports a database failure; "Unknown" when the backend cannot be reached

**Backend health endpoint directly:**

```bash
curl http://localhost:3001/health
# {"status":"ok","db":"connected"}
```

The `"db":"connected"` value reflects a real database query, not merely that a URL is configured.

If the database query fails, the endpoint returns HTTP 503 with a fixed body. Error details are written to the backend log only (`docker compose logs backend`), never to the response:

```json
{"status":"error","db":"unreachable"}
```

**Via the Vite proxy (same path the browser uses):**

```bash
curl http://localhost:5173/api/health
# {"status":"ok","db":"connected"}
```

---

## Development commands

### Docker (recommended)

```bash
# Start all services
docker compose up

# Start in background
docker compose up -d

# Rebuild after dependency changes
docker compose up --build

# Stop all services
docker compose down

# Stop and remove volumes (resets the database)
docker compose down -v

# View logs
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs -f postgres
```

### Local (without Docker)

You need a running PostgreSQL instance reachable on `localhost:5433` (for example `docker compose up -d postgres`) and `DATABASE_URL` from `.env` exported into your shell.

```bash
# Backend
cd backend
npm ci
set -a && . ../.env && set +a   # exports DATABASE_URL (localhost) into this shell
npm run dev

# Frontend (separate terminal)
cd frontend
npm ci
npm run dev   # proxies /api to http://localhost:3001
```

### Type checking and builds

```bash
# Backend
cd backend && npm run typecheck
cd backend && npm run build

# Frontend
cd frontend && npm run typecheck
cd frontend && npm run build
```

---

## Database migrations

Schema changes are made in `backend/src/schema.ts` and shipped as version-controlled
SQL migration files under `backend/drizzle/`, generated and applied with Drizzle Kit.
`drizzle-kit push` is not used for product schema — it skips the migration file, so
changes aren't reviewable or reproducible.

These commands run on the host, so they use the `localhost` `DATABASE_URL` from `.env`
(see "Database hostname: Compose vs. host" above):

```bash
cd backend
set -a && . ../.env && set +a
```

**Generate a migration** after changing `schema.ts`:

```bash
npm run db:generate
```

This writes a new timestamped `.sql` file (plus a snapshot) under `backend/drizzle/`.
**Always review the generated SQL by hand before applying it** — confirm it only
creates/alters the tables you intended, and contains no unexpected `DROP` or data-loss
statements. Commit the migration file to git once it looks right.

**Apply pending migrations:**

```bash
npm run db:migrate
```

This runs `drizzle-kit migrate`, which applies any `.sql` files in `backend/drizzle/`
that haven't been applied yet, tracked in a `__drizzle_migrations` table. Re-running it
is safe: already-applied migrations are skipped, nothing is re-created or reset.
Nothing in this stack runs schema sync automatically — the backend never applies
migrations on startup, so this is always an explicit, manual step.

**Verify migration status** by inspecting the applied-migrations table and the schema
directly:

```bash
set -a && . ../.env && set +a
psql "$DATABASE_URL" -c "SELECT * FROM drizzle.__drizzle_migrations ORDER BY id;"
psql "$DATABASE_URL" -c "\d candidate_profile"
```

### Candidate profile table

`candidate_profile` is a single-row (singleton) table: the primary key defaults to
`1` and a `CHECK` constraint rejects any other `id`, so at most one profile can ever
exist. **The migration does not create that row.** On a freshly migrated database,
`candidate_profile` has zero rows — the row is created lazily by the backend on the
first successful profile save (a later step). Until then, there is simply no profile
yet, which is the expected state for an unconfigured instance.

### Candidate skill table

`candidate_skill` (migration `0001`) holds the candidate's skills, one row each, with
an integer identity `id`. It is standalone — not linked to `candidate_profile` — and
is managed through the [Candidate skills API](#candidate-skills-api). The database enforces:

| Column | Rule |
|---|---|
| `name` | Required, at most 100 characters, not blank. Stored as entered (display capitalization is kept). Unique ignoring case and leading, trailing and repeated ASCII whitespace, so `TypeScript`, ` typescript ` and `TYPESCRIPT` are the same skill, as are `Machine Learning` and `machine  learning`. |
| `experience_contexts` | JSON array of distinct values from `professional`, `personal_project`, `academic`, `learning`. Defaults to `[]`. |
| `practical_confidence`, `interview_confidence` | Optional, independent, 1–5. |
| `experience_months` | Optional, 0–1200. |
| `last_used_year` | Optional, 1950–2100. |
| `notes` | Optional text. |
| `created_at`, `updated_at` | Set to `now()` on insert. There is no trigger: the skills API sets `updated_at` on every update. |

ASCII whitespace here means tab, line feed, vertical tab, form feed, carriage return
and space. Other whitespace, such as a no-break space, is an ordinary character.

### Candidate evidence tables

Migration `0002` adds two tables for evidence behind the candidate's skills. They are
**persistence only**: there is no evidence API or UI yet, so rows can only be written
directly in the database.

`candidate_evidence_source` holds one source of evidence each (a job, a project, a CV,
a portfolio), with an integer identity `id`. It is standalone, not linked to
`candidate_profile`. Every row is recorded manually by the candidate and is **not
verified**: `origin` records how the row was entered, not that anything was checked.
Titles, descriptions and URLs are untrusted text, and URLs are never fetched.

| Column | Rule |
|---|---|
| `type` | Required: `professional_experience`, `personal_project`, `cv`, `portfolio` or `other`. |
| `title` | Required, at most 200 characters, not blank (ASCII whitespace as above). Not unique. |
| `description` | Optional text. |
| `url` | Optional, at most 2048 characters, must start with `http://` or `https://` (any case). This is only a coarse scheme check. |
| `origin` | Defaults to `manual`, the only allowed value. |
| `reviewed_at` | Optional; `NULL` means not reviewed. Nothing sets or clears it automatically. |
| `created_at`, `updated_at` | Set to `now()` on insert. There is no trigger. |

`candidate_skill_evidence` links skills to sources, many-to-many: one row per
`(skill_id, evidence_source_id)` pair, which is the primary key, so a pair can be linked
only once. A skill or a source can exist without any links. Both columns are foreign
keys with `ON DELETE CASCADE`: deleting a skill or a source deletes its links, and
nothing else. Deleting a link leaves both the skill and the source alone. An index on
`evidence_source_id` serves lookups by source.

---

## Candidate profile API

The browser calls `/api/profile`; the Vite proxy strips `/api`, so the backend
route itself is `/profile` (the same convention as `/api/health` → `/health`).

| Request | Response |
|---------|----------|
| `GET /api/profile` | `200` with the profile, or `200` with `null` if none has been saved yet |
| `PUT /api/profile` | `200` with the saved profile; creates it on first save, updates it afterwards |

`PUT` takes the complete profile. All six keys are required; use `null` (or `[]`
for `targetRoles`) for anything not filled in yet. Any other key, including `id`
or `updatedAt`, is rejected.

```json
{
  "headline": "Senior Backend Engineer",
  "experienceSummary": "Ten years of TypeScript.",
  "location": "Athens, Greece",
  "targetRoles": ["Backend Engineer", "Platform Engineer"],
  "workModel": "hybrid",
  "careerInstructions": null
}
```

Responses contain these fields plus `updatedAt` (ISO 8601). The internal row id is
never exposed.

### Validation rules

| Field | Rule |
|-------|------|
| `headline`, `location` | string or null, max 200 characters; whitespace collapsed to single spaces |
| `experienceSummary` | string or null, max 10,000 characters; ends trimmed, line breaks kept |
| `careerInstructions` | string or null, max 5,000 characters; ends trimmed, line breaks kept |
| `targetRoles` | array of at most 20 strings, each 1–100 characters after trimming |
| `workModel` | `remote`, `hybrid`, `onsite`, `flexible`, or null |
| Body | JSON object, at most 128 kB (larger bodies get `413`) |

- Text that is empty after trimming is stored as `null`.
- Duplicate target roles (compared case-insensitively) are removed, keeping the
  first spelling and the original order.
- Control characters (other than tab and line breaks) and invalid Unicode are rejected.
- Limits count characters (Unicode code points), after whitespace normalization.

### Error responses

| Status | When | Body |
|--------|------|------|
| `400` | Validation failed | `{"error":"validation_error","message":"…","details":[{"field":"workModel","message":"…"}]}` |
| `400` | Malformed JSON | `{"error":"invalid_json","message":"…"}` |
| `413` | Body over 128 kB | `{"error":"payload_too_large","message":"…"}` |
| `503` | Database unreachable | `{"error":"database_unavailable","message":"…"}` |
| `500` | Anything unexpected | `{"error":"internal_error","message":"An unexpected error occurred."}` |

Error bodies never contain SQL, driver messages, connection details or stack traces.
The server log records only the method, path, an error category and a validated error
code (PostgreSQL SQLSTATE or connection code) — never raw driver messages, SQL,
parameters, profile content or stack traces.

---

## Candidate skills API

Like the profile, the browser calls `/api/skills`; the Vite proxy strips `/api`.

| Request | Response |
|---------|----------|
| `GET /api/skills` | `200` with an array of skills (`[]` if none), ordered by name ignoring case and ASCII whitespace, then by id |
| `POST /api/skills` | `201` with the created skill |
| `PUT /api/skills/:id` | `200` with the updated skill (full replacement) |
| `DELETE /api/skills/:id` | `204`, no body |

A skill in a response:

```json
{
  "id": 1,
  "name": "PostgreSQL",
  "experienceContexts": ["professional", "personal_project"],
  "practicalConfidence": 4,
  "interviewConfidence": 3,
  "experienceMonths": 36,
  "lastUsedYear": 2024,
  "notes": "Schema design and query tuning.",
  "createdAt": "2026-10-20T09:00:00.000Z",
  "updatedAt": "2026-10-20T09:00:00.000Z"
}
```

The seven writable fields are `name`, `experienceContexts`, `practicalConfidence`,
`interviewConfidence`, `experienceMonths`, `lastUsedYear` and `notes`. `id`,
`createdAt` and `updatedAt` are set by the server; sending them (or any other key) is
rejected.

- **`POST`** requires `name`. Omitted fields default to `[]` (`experienceContexts`) or
  `null` (the rest). An explicit `null` for `experienceContexts` is rejected.
- **`PUT`** replaces the whole skill. All seven fields are required; use `null` or `[]`
  to clear a value. An omitted field is rejected rather than silently cleared.
  `updatedAt` changes on every successful `PUT`, even if nothing else did; `createdAt`
  never changes.

### Skill validation rules

| Field | Rule |
|-------|------|
| `name` | string, 1–100 characters after normalization. Runs of tab, line feed, carriage return and space are collapsed to one space and the ends trimmed. Vertical tab and form feed are rejected as control characters. Non-ASCII whitespace (e.g. a no-break space) inside a name is kept as entered and counts toward the limit, but a name made only of whitespace of any kind is rejected. |
| `experienceContexts` | array of distinct values from `professional`, `personal_project`, `academic`, `learning` |
| `practicalConfidence`, `interviewConfidence` | integer 1–5, or null |
| `experienceMonths` | integer 0–1200, or null |
| `lastUsedYear` | integer from 1950 to the current UTC year, or null |
| `notes` | string or null, max 2,000 characters; ends trimmed, line breaks kept; blank stored as `null` |
| Body | JSON object, at most 128 kB (larger bodies get `413`) |

Control characters, invalid Unicode and character counting follow the profile rules above.

### Skill error responses

In addition to the profile's `400 validation_error` (message `The skill is invalid.`),
`400 invalid_json`, `413`, `503` and `500` responses:

| Status | When | Body |
|--------|------|------|
| `400` | `:id` is not a canonical positive integer within PostgreSQL `integer` range (`0`, `01`, `+1`, `1.0`, `2147483648`, …) | `{"error":"invalid_id","message":"…"}` |
| `404` | No skill has that id | `{"error":"not_found","message":"…"}` |
| `409` | Another skill has the same name, ignoring case and ASCII whitespace | `{"error":"duplicate_skill","message":"A skill with this name already exists."}` |

Duplicates are detected by the `candidate_skill_name_normalized_unique` index, not by a
lookup first, so concurrent requests cannot both succeed. Only a unique violation
(SQLSTATE `23505`) of that index becomes a `409`; any other database error stays a
generic `500` (or `503` if the database is unreachable). The `409` message is fixed and
never repeats either name.

---

## Backend tests

Tests use Node's built-in test runner (`node:test`) via `tsx`; no extra test framework.

```bash
cd backend && npm test
```

The API tests need a **disposable** PostgreSQL database in `TEST_DATABASE_URL`. They
apply the migrations to it and delete its `candidate_profile` rows between tests, so
they refuse to run unless the database name ends in `_test`, the port is not 5432
(native PostgreSQL) or 5433 (JobFlow development), and it differs from `DATABASE_URL`.

Start a throwaway database (in-memory storage, no volume, removed when stopped):

```bash
docker run -d --rm --name jobflow-test-db \
  -e POSTGRES_USER=jobflow_test -e POSTGRES_PASSWORD=disposable_test_pw -e POSTGRES_DB=jobflow_test \
  -p 127.0.0.1:55432:5432 --tmpfs /var/lib/postgresql/data postgres:16-alpine

cd backend
TEST_DATABASE_URL=postgresql://jobflow_test:disposable_test_pw@127.0.0.1:55432/jobflow_test npm test

docker stop jobflow-test-db
```

The database-unavailable tests (profile and skills) point the app at a closed port and need no database.

The skill schema tests (`test/skill-schema.test.ts`) create and drop their own
database (`<test db name>_skill_<pid>_test`) on the same disposable server, so the
`TEST_DATABASE_URL` user needs `CREATEDB` (the throwaway container's user above has it).
They apply migration `0000`, save a profile, then apply `0001` and check the profile is
unchanged, before testing each `candidate_skill` constraint.

The skills API tests (`test/skill-api.test.ts`) likewise create, migrate and drop their
own database (`<test db name>_skillapi_<pid>_test`), so they never share tables with
the profile API tests running in parallel. The database is dropped even when tests fail.

The evidence schema tests (`test/evidence-schema.test.ts`) create and drop their own
database (`<test db name>_evidence_<pid>_test`) the same way. They apply migrations
`0000`–`0001`, save a profile and skills, then apply `0002` and check that the saved
rows and the existing table definitions are unchanged, that a second run applies
nothing, and that each evidence constraint, foreign key and cascade behaves as described
in [Candidate evidence tables](#candidate-evidence-tables).

---

## Frontend tests

```bash
cd frontend && npm test
```

Unit tests for the profile and skills data conversions (`src/profile.ts`,
`src/skill.ts`) and API calls (`src/profileApi.ts`, `src/skillsApi.ts`, with `fetch`
stubbed) use Node's built-in test runner and run the `.ts` files directly through
Node's built-in TypeScript type stripping, so there is no extra test dependency. This
needs **Node.js 22.18 or newer** on the host. No server or database is required. Test
files are excluded from the app type check and build.

The components themselves (`ProfileForm.tsx`, `SkillsSection.tsx`, `SkillForm.tsx`:
React rendering, focus, live regions, the async flows) are not covered by these unit
tests; there is no DOM test framework in the project, so they are verified manually in
the browser.

---

## My skills (frontend)

The **My skills** section below the candidate profile lists skills in the order
`GET /api/skills` returns them, and adds (`POST`), edits (`PUT`, always all seven
fields) and deletes (`DELETE`, after an inline confirmation) them. One editor and one
request that changes data run at a time.

- Changes are **pessimistic**: the list changes only after the server confirms a
  write, and is then reloaded from the server rather than re-sorted in the browser.
  A confirmed delete removes the row even if that reload fails.
- A definite rejection (`400`, `404`, `409`, `413`) shows the error next to the field
  or in the form and keeps what was typed. A `409` marks the name field.
- When the outcome of a write is unknown (network failure, `500`, `503`, unexpected
  response), the write is **not** retried automatically. The list is reloaded so you
  can see what was stored; if that reload also fails, a warning offers **Reload list**.
- Experience months and last-used year must be typed as whole numbers. Other text is
  flagged before sending and left as typed. Ranges, name length, duplicate names and
  whitespace normalization are checked by the backend only.
