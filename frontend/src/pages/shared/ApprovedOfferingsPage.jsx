import { useMemo, useState } from "react";
import { ExternalLink, GraduationCap, Search } from "lucide-react";
import { approvedOfferings } from "../../data/mockStakeholderData";
import { formatINR, PageHeader, Panel, StatusPill } from "../../components/stakeholder/PortalPrimitives";
import { useStakeholder } from "../../context/StakeholderContext";

export default function ApprovedOfferingsPage() {
  const { role } = useStakeholder();
  const faculty = role === "faculty";
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState("All levels");
  const [accreditation, setAccreditation] = useState("All statuses");
  const courses = useMemo(() => approvedOfferings.filter((item) => {
    const matchesText = `${item.name} ${item.level}`.toLowerCase().includes(query.toLowerCase());
    return matchesText && (level === "All levels" || item.level === level)
      && (accreditation === "All statuses" || item.nba === accreditation);
  }), [query, level, accreditation]);

  return <div className="stakeholder-page">
    <PageHeader eyebrow="PUBLIC SELF-DISCLOSURE" title={faculty ? "College Overview & Offerings" : "Approved Courses & Offerings"}
      description="Search approved programmes and review the published intake, accreditation, and tuition-fee ceiling for 2026-27." />
    <div className="stakeholder-stat-row">
      <div className="stakeholder-stat"><GraduationCap size={19} /><div><span>Approved programmes</span><strong>{approvedOfferings.length}</strong></div></div>
      <div className="stakeholder-stat"><span className="stakeholder-stat-letter">UG</span><div><span>Undergraduate</span><strong>{approvedOfferings.filter((x) => x.level === "UG").length} programmes</strong></div></div>
      <div className="stakeholder-stat"><span className="stakeholder-stat-letter">PG</span><div><span>Postgraduate & diploma</span><strong>{approvedOfferings.filter((x) => x.level !== "UG").length} programmes</strong></div></div>
    </div>
    <Panel title="Programme approvals" description="Published programme intake and fee ceiling. Filters only affect this local demo table.">
      <div className="stakeholder-filter-row">
        <label className="stakeholder-search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search course name" aria-label="Search courses" /></label>
        <label>Level<select value={level} onChange={(event) => setLevel(event.target.value)}><option>All levels</option><option>UG</option><option>PG</option><option>Diploma</option></select></label>
        <label>NBA status<select value={accreditation} onChange={(event) => setAccreditation(event.target.value)}><option>All statuses</option><option>Accredited</option><option>Not Accredited</option></select></label>
      </div>
      <div className="stakeholder-table-wrap">
        <table className="stakeholder-table">
          <thead><tr><th>Level</th><th>Approved programme</th><th>Shift</th><th>Intake</th><th>NBA accreditation</th><th>Fee ceiling / year</th><th>Disclosure</th></tr></thead>
          <tbody>{courses.map((course) => <tr key={course.name}>
            <td><span className="stakeholder-level-chip">{course.level}</span></td>
            <td><strong>{course.name}</strong></td><td>{course.shift} shift</td><td>{course.intake}</td>
            <td>{course.nba === "Accredited" ? <StatusPill>{course.nba} · {course.nbaValid}</StatusPill> : <StatusPill tone="slate">Not Accredited</StatusPill>}</td>
            <td className="stakeholder-fee">{formatINR(course.fee)}</td>
            <td><a className="stakeholder-table-link" href={`data:text/plain;charset=utf-8,${encodeURIComponent(`${course.name} - ${course.placement} (fictional demo disclosure)`)}`} download={`demo-disclosure-${course.level.toLowerCase()}.txt`}>{course.placement}<ExternalLink size={13} /></a></td>
          </tr>)}</tbody>
        </table>
        {!courses.length && <p className="stakeholder-no-results">No approved courses match those filters.</p>}
      </div>
      <div className="stakeholder-table-foot">Showing {courses.length} of {approvedOfferings.length} publicly disclosed programmes · Intake and fee ceiling are fictional demo data.</div>
    </Panel>
  </div>;
}
