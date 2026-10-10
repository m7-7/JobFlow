import { useEffect, useState } from "react";

type HealthStatus =
  | { state: "loading" }
  | { state: "ok"; db: string }
  | { state: "error"; detail: string };

export default function App() {
  const [health, setHealth] = useState<HealthStatus>({ state: "loading" });

  useEffect(() => {
    fetch("/api/health")
      .then(async (res) => {
        const data = await res.json();
        if (res.ok) {
          setHealth({ state: "ok", db: data.db });
        } else {
          setHealth({ state: "error", detail: data.detail ?? "Backend returned an error" });
        }
      })
      .catch((err: unknown) => {
        setHealth({
          state: "error",
          detail: err instanceof Error ? err.message : "Network error",
        });
      });
  }, []);

  return (
    <main style={styles.main}>
      <h1 style={styles.title}>JobFlow</h1>
      <section style={styles.card}>
        <h2 style={styles.cardTitle}>System Status</h2>
        <StatusRow label="Frontend" status="ok" detail="React + Vite running" />
        <StatusRow
          label="Backend"
          status={health.state === "loading" ? "loading" : health.state}
          detail={
            health.state === "loading"
              ? "Checking…"
              : health.state === "ok"
                ? "HTTP /health responded"
                : health.detail
          }
        />
        <StatusRow
          label="PostgreSQL"
          status={health.state === "loading" ? "loading" : health.state}
          detail={
            health.state === "loading"
              ? "Checking…"
              : health.state === "ok"
                ? `Drizzle connected — db: ${health.db}`
                : "Unreachable"
          }
        />
      </section>
    </main>
  );
}

function StatusRow({
  label,
  status,
  detail,
}: {
  label: string;
  status: "loading" | "ok" | "error";
  detail: string;
}) {
  const indicator = status === "loading" ? "⏳" : status === "ok" ? "✅" : "❌";
  const color = status === "loading" ? "#888" : status === "ok" ? "#1a7a1a" : "#b00020";
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
