import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { Badge, Card } from "../components/ui/primitives";

export default function DeficienciesLive({ data }) {
  const returnedCases = data.cases.filter((item) => item.status === "Action required");

  return <Card title="Returned applications" description="Return reasons come from the case record.">
    {returnedCases.length === 0
      ? <p className="muted">No returned applications are available in your scope.</p>
      : <div className="queue-list">{returnedCases.map((item) => <article className="queue-row" key={item.caseId}>
        <span className="queue-priority"><AlertTriangle size={17} /></span>
        <div className="queue-main">
          <strong>{item.id} · {item.type}</strong>
          <small>{item.institution}</small>
          <p>{item.returnReason || "No return reason was recorded on this case."}</p>
        </div>
        <Badge variant="warning">Returned</Badge>
        <Link className="button button-secondary button-small" to={`/case/${item.caseId}`}>Open case</Link>
      </article>)}</div>}
  </Card>;
}
