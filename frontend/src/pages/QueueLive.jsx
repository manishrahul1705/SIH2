import { Link } from "react-router-dom";
import { Activity, ClipboardCheck, Clock3, FileText } from "lucide-react";
import { Badge, Card, StatCard } from "../components/ui/primitives";

export default function QueueLive({ data }) {
  const cases = data.cases;
  const inProgress = cases.filter((item) => item.status === "In progress");
  const returned = cases.filter((item) => item.status === "Action required");
  const institutionHeld = cases.filter((item) => item.holder === "Institution");

  return <>
    <div className="stat-grid">
      <StatCard label="Cases in scope" value={cases.length} icon={FileText} />
      <StatCard label="In progress" value={inProgress.length} icon={Activity} />
      <StatCard label="Returned" value={returned.length} icon={ClipboardCheck} />
      <StatCard label="Institution-held" value={institutionHeld.length} icon={Clock3} />
    </div>
    <Card title="Cases in your authorized scope" description="Queue content is loaded from the authenticated case service.">
      {cases.length === 0
        ? <p className="muted">No cases are currently available in your scope.</p>
        : <div className="queue-list">{cases.map((item) => <div className="queue-row" key={item.caseId}>
          <span className="queue-priority"><FileText size={16} /></span>
          <div className="queue-main">
            <Link to={`/case/${item.caseId}`} className="text-link mono">{item.id}</Link>
            <strong>{item.institution}</strong>
            <small>{item.type} · {item.stage} · {item.holder}</small>
          </div>
          <Badge variant={item.status === "Approved" ? "success" : item.status === "Action required" ? "warning" : "info"}>{item.status}</Badge>
          <Link className="button button-secondary button-small" to={`/case/${item.caseId}`}>Open</Link>
        </div>)}</div>}
    </Card>
  </>;
}
