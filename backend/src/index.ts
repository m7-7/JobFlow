import cors from "cors";
import express from "express";
import { sql } from "drizzle-orm";
import { db } from "./db.js";

const app = express();
const port = process.env.PORT ?? "3001";

// Allow requests from the Vite dev server (host-side development only)
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((o) => o.trim())
  : ["http://localhost:5173"];

app.use(cors({ origin: allowedOrigins, credentials: false }));
app.use(express.json());

app.get("/health", async (_req, res) => {
  try {
    // Prove real connectivity: execute a minimal round-trip query
    await db.execute(sql`SELECT 1`);
    res.json({ status: "ok", db: "connected" });
  } catch (err) {
    // Log error class only — never log the connection string
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("Health check DB error:", message);
    res.status(503).json({ status: "error", db: "unreachable", detail: message });
  }
});

app.listen(Number(port), () => {
  console.log(`Backend listening on port ${port}`);
});
