import { useState } from "react";
import { ArrowDownToLine, Eye, FileCheck2, Printer, X } from "lucide-react";
import { PageHeader, Panel, SafeguardNote, StatusPill } from "../../components/stakeholder/PortalPrimitives";
import { useStakeholder } from "../../context/StakeholderContext";

function tone(status) {
  if (status.includes("Verified")) return "green";
  if (status.includes("Returned")) return "amber";
  if (status === "Draft") return "slate";
  return "blue";
}

export default function FacultyYearlyReportsHistoryPage() {
  const { reports, faculty } = useStakeholder();
  const [selected, setSelected] = useState(null);
  return <div className="stakeholder-page">
    <PageHeader eyebrow="FACULTY SUBMISSIONS" title="My Yearly Reports History"
      description="Review current and previous annual academic and compliance report submissions." />
    <SafeguardNote tone="amber">Reports remain Pending Institutional Nodal Sign-Off until institution verification. A submission does not start a clock, change routing, or write to a score or policy table.</SafeguardNote>
    <Panel title="Annual reports" description={`Faculty profile: ${faculty.fullName} · ${faculty.department}`}>
      <div className="stakeholder-report-list">{reports.map((report) => <article className="stakeholder-report-card" key={report.id}>
        <div className="stakeholder-report-icon"><FileCheck2 size={20} /></div>
        <div className="stakeholder-report-copy"><div><strong>Academic year {report.year}</strong><StatusPill tone={tone(report.status)}>{report.status}</StatusPill></div><p>{report.summary}</p><small>{report.id}{report.submittedAt ? ` · Submitted ${report.submittedAt}` : " · Not submitted"}</small>
          {report.returnedReason && <div className="stakeholder-return-reason"><strong>Correction requested</strong><span>{report.returnedReason}</span></div>}
        </div>
        <button type="button" className="stakeholder-button secondary small" onClick={() => setSelected(report)}><Eye size={15} />Preview</button>
      </article>)}</div>
    </Panel>
    {selected && <div className="stakeholder-modal-backdrop" role="presentation" onClick={() => setSelected(null)}>
      <section className="stakeholder-modal" role="dialog" aria-modal="true" aria-labelledby="report-preview-title" onClick={(event) => event.stopPropagation()}>
        <div className="stakeholder-modal-heading"><div><p className="stakeholder-eyebrow">FACULTY REPORT PREVIEW</p><h2 id="report-preview-title">{selected.year} annual report</h2></div><button className="stakeholder-icon-action" onClick={() => setSelected(null)} aria-label="Close preview"><X size={18} /></button></div>
        <div className="stakeholder-report-preview"><StatusPill tone={tone(selected.status)}>{selected.status}</StatusPill><p>{selected.summary}</p><div><strong>Report reference</strong><span>{selected.id}</span></div><div><strong>Submission timestamp</strong><span>{selected.submittedAt || "Not submitted"}</span></div>{selected.returnedReason && <div className="stakeholder-return-reason"><strong>Correction requested</strong><span>{selected.returnedReason}</span></div>}</div>
        <SafeguardNote>Pending Institutional Nodal Sign-Off. This preview is a fictional local demo record.</SafeguardNote>
        <div className="stakeholder-modal-actions"><button className="stakeholder-button secondary" onClick={() => window.print()}><Printer size={15} />Print summary</button><a className="stakeholder-button secondary" href={`data:text/plain;charset=utf-8,${encodeURIComponent(`${selected.year} Faculty Report\n${selected.id}\n${selected.status}\n${selected.summary}\nPending Institutional Nodal Sign-Off`)}`} download={`${selected.id}.txt`}><ArrowDownToLine size={15} />Download summary</a></div>
      </section>
    </div>}
  </div>;
}
