import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// Integration tests run against a disposable database only. This guard runs
// before the app (and its db client) is imported, and refuses anything that
// could be the development database or the native PostgreSQL. Error messages
// never echo the URL, since it contains a password.
export function useDisposableTestDatabase(): void {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Integration tests need a disposable PostgreSQL database (see README: Backend tests)."
    );
  }
  const test = new URL(url);
  const dbName = test.pathname.slice(1);
  const port = test.port || "5432";
  if (!dbName.endsWith("_test")) {
    throw new Error("Refusing to run: the TEST_DATABASE_URL database name must end in _test.");
  }
  // 5432: native PostgreSQL. 5433: JobFlow development database.
  if (port === "5432" || port === "5433") {
    throw new Error(`Refusing to run: TEST_DATABASE_URL must not use port ${port}.`);
  }
  if (process.env.DATABASE_URL) {
    const dev = new URL(process.env.DATABASE_URL);
    if (dev.host === test.host && dev.pathname === test.pathname) {
      throw new Error("Refusing to run: TEST_DATABASE_URL points at the same database as DATABASE_URL.");
    }
  }
  // db.ts reads DATABASE_URL when first imported.
  process.env.DATABASE_URL = url;
}

export async function listen(app: { listen: (port: number, host: string) => Server }) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Collects console.error output (and keeps it out of the test report) so
// tests can assert what the server logs.
export function captureConsoleError() {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return { lines, restore: () => (console.error = original) };
}

// Strings that must never appear in an HTTP error response.
export const SENSITIVE_MARKERS = [
  "postgres",
  "postgresql://",
  "password",
  "select ",
  "insert ",
  "candidate_profile",
  "drizzle",
  "ECONNREFUSED",
  "127.0.0.1",
  "localhost",
  "    at ", // stack trace frame
];

export function assertNoSensitiveContent(body: string, extra: string[] = []): void {
  const lower = body.toLowerCase();
  for (const marker of [...SENSITIVE_MARKERS, ...extra]) {
    if (lower.includes(marker.toLowerCase())) {
      throw new Error(`Response contains sensitive marker ${JSON.stringify(marker)}`);
    }
  }
}
