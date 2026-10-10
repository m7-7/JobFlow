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
│   │   └── schema.ts  # Database schema (empty until Chapter 3)
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

2. Open `.env` and set a real password for `POSTGRES_PASSWORD` (and update `DATABASE_URL` to match):
   ```dotenv
   POSTGRES_PASSWORD=your_secure_password_here
   DATABASE_URL=postgresql://jobflow:your_secure_password_here@postgres:5432/jobflow
   ```

   > `.env` is listed in `.gitignore` and must never be committed.

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `POSTGRES_USER` | No (default: `jobflow`) | PostgreSQL username |
| `POSTGRES_PASSWORD` | **Yes** | PostgreSQL password — set a real value |
| `POSTGRES_DB` | No (default: `jobflow`) | PostgreSQL database name |
| `DATABASE_URL` | **Yes** | Full connection string used by the backend. In Docker Compose the hostname is `postgres` (the service name). For local development outside Docker use `localhost`. |

> Database credentials never reach the frontend. `DATABASE_URL` is a backend-only variable.

---

## Start the development environment

```bash
docker compose up --build
```

This starts three services:

| Service | Container port | Host port |
|---------|---------------|-----------|
| PostgreSQL | 5432 | 5432 |
| Backend (Node/Express) | 3001 | 3001 |
| Frontend (Vite dev server) | 5173 | 5173 |

The backend waits for PostgreSQL to pass its health check before starting.

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
- **Backend** — green when the HTTP call to `/api/health` succeeds
- **PostgreSQL** — green when Drizzle successfully executes `SELECT 1`

**Backend health endpoint directly:**

```bash
curl http://localhost:3001/health
# {"status":"ok","db":"connected"}
```

The `"db":"connected"` value reflects a real database query, not merely that a URL is configured.

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

You need a running PostgreSQL instance and `DATABASE_URL` pointing to `localhost`.

```bash
# Backend
cd backend
npm install
DATABASE_URL=postgresql://jobflow:password@localhost:5432/jobflow npm run dev

# Frontend (separate terminal)
cd frontend
npm install
npm run dev
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

Drizzle Kit is configured for future schema migrations. No product tables exist in this foundation step.

```bash
# Generate a migration from schema changes (future use)
cd backend && npx drizzle-kit generate

# Push schema directly to the database (development only)
cd backend && DATABASE_URL=... npx drizzle-kit push
```
