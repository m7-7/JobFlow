import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required");
}

// postgres.js connects lazily, on the first query. Never log connectionString:
// it contains the database password.
const client = postgres(connectionString);
export const db = drizzle(client);
