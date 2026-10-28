import { CalendarClock, FileText } from "lucide-react";
import { Badge, Card, StatCard } from "../components/ui/primitives";
import { caseWorkflowApi } from "../services/caseWorkflow";

function visitDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not scheduled" : date.toLocaleString();
}

export default function EvcVisitsLive({ data }) {
  const visits = data.evc;
  const scheduled = visits.filter((visit) => visit.status === "SCHEDULED");
  const completed = visits.filter((visit) => visit.status === "DONE");

  return <>
    <div className="stat-grid">
      <StatCard label="Visits in scope" value={visits.length} icon={CalendarClock} />
      <StatCard label="Scheduled" value={scheduled.length} icon={CalendarClock} />
      <StatCard label="Completed" value={completed.length} icon={FileText} />
    </div>
    <Card title="EVC visits" description="Visit records assigned to or visible in your authenticated scope.">
      {visits.length === 0
        ? <p className="muted">No EVC visits are available in your scope.</p>
        : <div className="queue-list">{visits.map((visit) => {
          const application = visit.application_id;
          return <article className="queue-row" key={visit._id}>
            <span className="queue-priority"><CalendarClock size={17} /></span>
            <div className="queue-main">
              <strong>{application?.application_number || application?._id || "Application reference unavailable"}</strong>
              <small>{visitDate(visit.scheduled_at)}</small>
              {visit.notes && <small>{visit.notes}</small>}
            </div>
            <Badge variant={visit.status === "DONE" ? "success" : visit.status === "CANCELLED" ? "neutral" : "info"}>{visit.status}</Badge>
            {visit.report_file_id && <a className="button button-secondary button-small" href={caseWorkflowApi.getDocumentDownloadUrl(visit.report_file_id)}>View report</a>}
          </article>;
        })}</div>}
    </Card>
  </>;
}
