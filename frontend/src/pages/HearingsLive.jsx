import { Link } from "react-router-dom";
import { Users } from "lucide-react";
import { Badge, Card } from "../components/ui/primitives";

export default function HearingsLive({ data }) {
  const hearingCases = data.cases.filter((item) => ["shc", "sac"].includes(item.stage));

  return <Card title="Cases assigned to committee stages" description="Only cases available in the authenticated committee scope are shown.">
    {hearingCases.length === 0
      ? <p className="muted">No cases are currently assigned to an SHC or SAC stage.</p>
      : <div className="queue-list">{hearingCases.map((item) => <div className="queue-row" key={item.caseId}>
        <span className="queue-priority"><Users size={17} /></span>
        <div className="queue-main"><strong>{item.id} · {item.institution}</strong><small>{item.type} · {item.stage}</small></div>
        <Badge variant={item.status === "Action required" ? "warning" : "info"}>{item.status}</Badge>
        <Link className="button button-secondary button-small" to={`/case/${item.caseId}`}>Open case</Link>
      </div>)}</div>}
  </Card>;
}
