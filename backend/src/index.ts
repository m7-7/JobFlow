import express from "express";
import { sql } from "drizzle-orm";
import { db } from "./db.js";

const app = express();
const port = process.env.PORT ?? "3001";

// No CORS middleware: the browser reaches this API only through the Vite
// dev server's same-origin /api proxy.
app.use(express.json());

app.get("/health", async (_req, res) => {
  try {
    // Prove real connectivity: execute a minimal round-trip query
    await db.execute(sql`SELECT 1`);
    res.json({ status: "ok", db: "connected" });
  } catch (err) {
    // Details stay in the server log only. Drizzle wraps the driver error in
    // `cause`. postgres.js error messages do not include the password or
    // connection string, but can include the DB username, hostnames and
    // internal IPs, so they are never sent to clients.
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
    const code = (cause as { code?: unknown })?.code ?? "unknown";
    const message = cause instanceof Error ? cause.message : "unknown error";
    console.error(`Health check DB error [${code}]: ${message}`);
    res.status(503).json({ status: "error", db: "unreachable" });
  }
});

app.listen(Number(port), () => {
  console.log(`Backend listening on port ${port}`);
});
