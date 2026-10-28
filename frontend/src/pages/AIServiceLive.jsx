import { useCallback, useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { Badge, Card } from "../components/ui/primitives";

const API_BASE_URL = import.meta.env?.VITE_API_BASE_URL || "http://localhost:4000/api/v1";

export default function AIServiceLive() {
  const [health, setHealth] = useState(null);
  const [error, setError] = useState("");

  const loadHealth = useCallback(async () => {
    setError("");
    try {
      const response = await fetch(`${API_BASE_URL.replace(/\/api\/v1\/?$/, "")}/health`, { credentials: "include" });
      const result = await response.json().catch(() => null);
      if (!response.ok && !result?.data) throw new Error(result?.error?.message || `Health request failed (${response.status}).`);
      setHealth(result?.data || null);
    } catch (loadError) {
      setError(loadError.message || "Service health could not be loaded.");
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    loadHealth();
  }, [loadHealth]);

  if (error) return <Card title="Service health"><div className="note warning-note" role="alert">{error}<button className="text-link" onClick={loadHealth}>Retry</button></div></Card>;
  if (!health) return <Card title="Service health"><div className="loading-state" aria-label="Loading service health"><i /><i /><i /></div></Card>;

  return <>
    <Card title="Backend service health" description="Live dependency checks reported by the backend.">
      <div className="notification-list">
        {Object.entries(health.checks || {}).map(([name, status]) => <div className="notification-item" key={name}>
          <Activity size={17} />
          <div className="notification-copy"><strong>{name}</strong></div>
          <Badge variant={status === "ok" ? "success" : "warning"}>{status}</Badge>
        </div>)}
      </div>
    </Card>
    <Card title="AI controls">
      <p className="muted">The backend does not currently expose an AI enable/disable or model-register endpoint. No local-only control is shown.</p>
    </Card>
  </>;
}
