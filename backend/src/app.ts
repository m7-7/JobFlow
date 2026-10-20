import express from "express";
import { sql } from "drizzle-orm";
import { db } from "./db.js";
import { profileRouter } from "./profile-routes.js";
import { skillRouter } from "./skill-routes.js";
import { errorHandler, safeDiagnostic } from "./errors.js";

// The Express app, separate from index.ts (which only listens) so tests can
// start it on an ephemeral port.
export const app = express();

// No CORS middleware: the browser reaches this API only through the Vite
// dev server's same-origin /api proxy.
//
// Bounded body size. The largest valid profile is ~17,400 characters
// (see LIMITS in profile-validation.ts) and the largest valid skill ~2,100
// (SKILL_LIMITS in skill-validation.ts); 128kb leaves room for multi-byte
// UTF-8 and JSON escaping. Larger bodies are rejected with 413.
app.use(express.json({ limit: "128kb" }));

app.get("/health", async (_req, res) => {
  try {
    // Prove real connectivity: execute a minimal round-trip query
    await db.execute(sql`SELECT 1`);
    res.json({ status: "ok", db: "connected" });
  } catch (err) {
    // Log a category and validated code only (see safeDiagnostic). Raw driver
    // messages can include the DB username, hostnames and internal IPs, so
    // they are neither logged nor sent to clients.
    const { category, detail } = safeDiagnostic(err);
    console.error(`Health check failed: ${category} [${detail}]`);
    res.status(503).json({ status: "error", db: "unreachable" });
  }
});

app.use("/profile", profileRouter);
app.use("/skills", skillRouter);

app.use(errorHandler);
