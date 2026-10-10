import { defineConfig } from "drizzle-kit";

// drizzle-kit requires this file to know where migrations will live and which
// database to connect to when running `drizzle-kit generate` / `push`.
// No product schema is defined in this step — this is infrastructure-only.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
