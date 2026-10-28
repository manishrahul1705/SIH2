import { useMemo, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { Badge, Card } from "../components/ui/primitives";
import { caseWorkflowApi } from "../services/caseWorkflow";

export default function DecisionsLive({ data, setMessage }) {
  const eligibleCases = useMemo(() => data.cases.filter((item) => (
    item.stage === "decision"
    && item.status === "In progress"
    && item.completedStages?.length >= Math.max(0, item.route.length - 1)
  )), [data.cases]);
  const [selectedId, setSelectedId] = useState("");
  const [outcome, setOutcome] = useState("approved");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = eligibleCases.find((item) => item.caseId === selectedId) || eligibleCases[0];

  async function submitDecision(event) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      await caseWorkflowApi.recordDecision(selected.caseId, {
        expectedVersion: selected.version,
        outcome,
        reason: reason.trim(),
        conditions: [],
      });
      setMessage(`Decision recorded for ${selected.id}.`);
      setReason("");
      setSelectedId("");
    } catch (requestError) {
      setError(requestError.message || "The decision could not be recorded.");
    } finally {
      setBusy(false);
    }
  }

  if (eligibleCases.length === 0) {
    return <Card title="Cases ready for decision"><p className="muted">No cases have completed their configured route and are awaiting a decision.</p></Card>;
  }

  return <div className="split-content">
    <Card title="Cases ready for decision">
      <div className="queue-list">{eligibleCases.map((item) => <button className={`verification-record ${selected?.caseId === item.caseId ? "selected" : ""}`} key={item.caseId} onClick={() => setSelectedId(item.caseId)}>
        <CheckCircle2 size={17} />
        <span><strong>{item.id}</strong><small>{item.institution} · {item.type}</small></span>
        <Badge variant="info">{item.stage}</Badge>
      </button>)}</div>
    </Card>
    <Card title="Record final decision" description={selected?.id}>
      {error && <div className="note warning-note" role="alert">{error}</div>}
      <form onSubmit={submitDecision}>
        <label className="field-label">Outcome
          <select value={outcome} onChange={(event) => setOutcome(event.target.value)}>
            <option value="approved">Approve</option>
            <option value="rejected">Reject</option>
          </select>
        </label>
        <label className="field-label">Reason<textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={1} maxLength={3000} required /></label>
        <button className="button button-primary full-button" type="submit" disabled={busy || !reason.trim()}>{busy ? "Recording…" : "Record decision"}</button>
      </form>
    </Card>
  </div>;
}
