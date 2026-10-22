import { useEffect, useState } from "react";
import ProfileForm from "./ProfileForm.tsx";
import SkillsSection from "./SkillsSection.tsx";

type HealthState = "loading" | "ok" | "db-unavailable" | "backend-unreachable";

type RowStatus = "loading" | "ok" | "error" | "unknown";

const BACKEND_ROW: Record<HealthState, [RowStatus, string]> = {
  loading: ["loading", "Checking…"],
  ok: ["ok", "HTTP /health responded"],
  "db-unavailable": ["ok", "HTTP /health responded"],
  "backend-unreachable": ["error", "Backend unreachable"],
};

const DATABASE_ROW: Record<HealthState, [RowStatus, string]> = {
  loading: ["loading", "Checking…"],
  ok: ["ok", "Drizzle connected (SELECT 1)"],
  "db-unavailable": ["error", "Database unavailable"],
  "backend-unreachable": ["unknown", "Unknown (backend unreachable)"],
};

// Backend contract: 200 {status:"ok"} or 503 {status:"error", db:"unreachable"}.
// Anything else (network failure, proxy error, non-JSON body) means the backend
// itself could not be reached, so the database state is unknown.
async function checkHealth(): Promise<HealthState> {
  let res: Response;
  try {
    res = await fetch("/api/health");
  } catch {
    return "backend-unreachable";
  }
  const data: unknown = await res.json().catch(() => null);
  const status =
    typeof data === "object" && data !== null && "status" in data ? data.status : undefined;
  if (res.ok && status === "ok") return "ok";
  if (res.status === 503 && status === "error") return "db-unavailable";
  return "backend-unreachable";
}

export default function App() {
  const [health, setHealth] = useState<HealthState>("loading");

  useEffect(() => {
    checkHealth().then(setHealth);
  }, []);

  const [backendStatus, backendDetail] = BACKEND_ROW[health];
  const [dbStatus, dbDetail] = DATABASE_ROW[health];

  return (
    <main style={styles.main}>
      <h1 style={styles.title}>JobFlow</h1>
      <section style={styles.card}>
        <h2 style={styles.cardTitle}>System Status</h2>
        <StatusRow label="Frontend" status="ok" detail="React + Vite running" />
        <StatusRow label="Backend" status={backendStatus} detail={backendDetail} />
        <StatusRow label="PostgreSQL" status={dbStatus} detail={dbDetail} />
      </section>
      <ProfileForm />
      <SkillsSection />
    </main>
  );
}

function StatusRow({
  label,
  status,
  detail,
}: {
  label: string;
  status: RowStatus;
  detail: string;
}) {
  const indicator = { loading: "⏳", ok: "✅", error: "❌", unknown: "❔" }[status];
  const color = { loading: "#888", ok: "#1a7a1a", error: "#b00020", unknown: "#888" }[status];
  return (
    <div style={styles.row}>
      <span style={styles.label}>{label}</span>
      <span style={{ ...styles.badge, color }}>
        {indicator} {status}
      </span>
      <span style={styles.detail}>{detail}</span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    fontFamily: "system-ui, sans-serif",
    maxWidth: 560,
    margin: "80px auto",
    padding: "0 16px",
  },
  title: { fontSize: 28, marginBottom: 24, color: "#111" },
  card: {
    border: "1px solid #ddd",
    borderRadius: 8,
    padding: 24,
    background: "#fafafa",
  },
  cardTitle: { fontSize: 16, fontWeight: 600, marginBottom: 16, color: "#444" },
  row: {
    display: "grid",
    gridTemplateColumns: "120px 100px 1fr",
    alignItems: "center",
    gap: 8,
    padding: "8px 0",
    borderBottom: "1px solid #eee",
  },
  label: { fontWeight: 600, fontSize: 14 },
  badge: { fontSize: 13, fontWeight: 600 },
  detail: { fontSize: 13, color: "#555" },
};
