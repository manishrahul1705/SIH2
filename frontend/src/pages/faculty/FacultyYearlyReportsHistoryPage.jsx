import { useState } from "react";
import { Eye, FileCheck2, Printer, X } from "lucide-react";
import { Link } from "react-router-dom";
import { PageHeader, Panel, SafeguardNote, StatusPill } from "../../components/stakeholder/PortalPrimitives";
import { useStakeholder } from "../../context/StakeholderContext";
import { reportSummary } from "../../services/stakeholder";

function statusLabel(status = "") {
  return status.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function tone(status = "") {
  if (status === "APPROVED") return "green";
  if (status === "RETURNED" || status === "OVERDUE") return "amber";
  if (status === "DRAFT") return "slate";
  return "blue";
}

export default function FacultyYearlyReportsHistoryPage() {
  const { reports, faculty, loading, error } = useStakeholder();
  const [selected, setSelected] = useState(null);
  return <div className="stakeholder-page">
    <PageHeader eyebrow="FACULTY SUBMISSIONS" title="My Yearly Reports History"
      description="Reports returned by the authenticated yearly-report API." />
    <SafeguardNote tone="amber">The status shown is the backend report status. No verification or approval is implied beyond that recorded status.</SafeguardNote>
    <Panel title="Annual reports" description={`Faculty profile: ${faculty?.name || "Not linked"} · ${faculty?.department || "Department not recorded"}`}>
      {loading ? <p>Loading reports...</p> : error ? <p role="alert">{error}</p> : reports.length ? <div className="stakeholder-report-list">{reports.map((report) => <article className="stakeholder-report-card" key={report._id}>
        <div className="stakeholder-report-icon"><FileCheck2 size={20} /></div>
        <div className="stakeholder-report-copy"><div><strong>Academic year {report.academic_year}</strong><StatusPill tone={tone(report.status)}>{statusLabel(report.status)}</StatusPill></div><p>{reportSummary(report)}</p><small>{report._id}{report.submitted_at ? ` · Submitted ${new Date(report.submitted_at).toLocaleString()}` : " · Not submitted"}</small></div>
        <button type="button" className="stakeholder-button secondary small" onClick={() => setSelected(report)}><Eye size={15} />View report</button>
      </article>)}</div> : <div className="stakeholder-empty"><strong>No yearly reports found</strong><p>There are no backend reports for this faculty profile.</p><Link className="stakeholder-button primary" to="/faculty/yearly-report/new">Create report</Link></div>}
    </Panel>
    {selected && <div className="stakeholder-modal-backdrop" role="presentation" onClick={() => setSelected(null)}>
      <section className="stakeholder-modal" role="dialog" aria-modal="true" aria-labelledby="report-preview-title" onClick={(event) => event.stopPropagation()}>
        <div className="stakeholder-modal-heading"><div><p className="stakeholder-eyebrow">BACKEND REPORT</p><h2 id="report-preview-title">{selected.academic_year} annual report</h2></div><button className="stakeholder-icon-action" onClick={() => setSelected(null)} aria-label="Close report"><X size={18} /></button></div>
        <div className="stakeholder-report-preview"><StatusPill tone={tone(selected.status)}>{statusLabel(selected.status)}</StatusPill>
          <div><strong>Report reference</strong><span>{selected._id}</span></div>
          <div><strong>Due date</strong><span>{selected.due_date ? new Date(selected.due_date).toLocaleDateString() : "Not recorded"}</span></div>
          <div><strong>Submission timestamp</strong><span>{selected.submitted_at ? new Date(selected.submitted_at).toLocaleString() : "Not submitted"}</span></div>
          <p>{reportSummary(selected)}</p>
        </div>
        <div className="stakeholder-modal-actions"><button className="stakeholder-button secondary" onClick={() => window.print()}><Printer size={15} />Print backend summary</button></div>
      </section>
    </div>}
  </div>;
}
