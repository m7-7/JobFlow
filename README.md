# JobFlow

Self-hosted Job Search Automation application.

**Stack:** React + TypeScript frontend · Node.js + TypeScript backend · Drizzle ORM · PostgreSQL · Docker Compose

---

## Prerequisites

| Tool | Minimum version |
|------|----------------|
| [Docker](https://docs.docker.com/get-docker/) | 24+ |
| Docker Compose (included with Docker Desktop) | v2 |
| [Node.js](https://nodejs.org/) | 22 (local dev only) |
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
│   │   ├── index.ts   # HTTP server entry point
│   │   ├── db.ts      # Drizzle client initialisation
│   │   └── schema.ts  # Database schema (candidate_profile)
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
   DATABASE_URL=postgresql://jobflow:your_secure_password_here@localhost:5432/jobflow
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
| Commands on the host | `localhost` (port 5432 is published to `127.0.0.1`) | `DATABASE_URL` in `.env`, exported into your shell (see below). |

> Database credentials never reach the frontend. `DATABASE_URL` is a backend-only variable, and the frontend container receives only `BACKEND_PROXY_TARGET`.

---

## Start the development environment

```bash
docker compose up --build
```

This starts three services:

| Service | Container port | Host port |
|---------|---------------|-----------|
| PostgreSQL | 5432 | 127.0.0.1:5432 |
| Backend (Node/Express) | 3001 | 127.0.0.1:3001 |
| Frontend (Vite dev server) | 5173 | 127.0.0.1:5173 |

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

You need a running PostgreSQL instance reachable on `localhost:5432` (for example `docker compose up -d postgres`) and `DATABASE_URL` from `.env` exported into your shell.

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
