import { useState } from "react";
import { Beaker, GraduationCap, Users } from "lucide-react";
import { departmentRoster } from "../../data/mockStakeholderData";
import { PageHeader, Panel, SafeguardNote, StatusPill } from "../../components/stakeholder/PortalPrimitives";
import { useStakeholder } from "../../context/StakeholderContext";

export default function DepartmentRosterPage() {
  const { faculty } = useStakeholder();
  const [selected, setSelected] = useState(faculty.department);
  const department = departmentRoster.find((item) => item.department === selected) || departmentRoster[0];
  const cadreRows = [
    ["Professor", department.professor],
    ["Associate Professor", department.associate],
    ["Assistant Professor", department.assistant],
  ];
  return <div className="stakeholder-page">
    <PageHeader eyebrow="PUBLIC SELF-DISCLOSURE" title="Department & Cadre Roster"
      description="Published department faculty strength, cadre distribution, doctoral qualifications, and laboratory mapping." />
    <SafeguardNote>Roster figures are fictional public disclosures. They are not an individual HR record or an independent compliance finding.</SafeguardNote>
    <Panel title="Select a department" description="Choose a department to review the published roster.">
      <label className="stakeholder-department-select">Department<select value={selected} onChange={(event) => setSelected(event.target.value)}>{departmentRoster.map((item) => <option key={item.department}>{item.department}</option>)}</select></label>
    </Panel>
    <div className="stakeholder-stat-row">
      <div className="stakeholder-stat"><Users size={20} /><div><span>Faculty available</span><strong>{cadreRows.reduce((total, [, count]) => total + count.available, 0)}</strong></div></div>
      <div className="stakeholder-stat"><GraduationCap size={20} /><div><span>Faculty with Ph.D.</span><strong>{department.phd}</strong></div></div>
      <div className="stakeholder-stat"><Beaker size={20} /><div><span>Department laboratories</span><strong>{department.labs.length}</strong></div></div>
    </div>
    <div className="stakeholder-two-column">
      <Panel title="Cadre position" description="Published required and available faculty counts.">
        <div className="stakeholder-table-wrap"><table className="stakeholder-table stakeholder-cadre-table">
          <thead><tr><th>Designation</th><th>Required</th><th>Available</th><th>Disclosure status</th></tr></thead>
          <tbody>{cadreRows.map(([name, count]) => <tr key={name}><td><strong>{name}</strong></td><td>{count.required}</td><td>{count.available}</td><td>{count.available >= count.required ? <StatusPill>Meets published count</StatusPill> : <StatusPill tone="amber">Reported gap</StatusPill>}</td></tr>)}</tbody>
        </table></div>
        <p className="stakeholder-small-disclaimer">Displayed figures do not independently verify appointments or determine institutional approval.</p>
      </Panel>
      <Panel title="Laboratory mapping" description={`${department.department} · public disclosure.`}>
        <div className="stakeholder-lab-map">{department.labs.map((lab, index) => <div key={lab}><span>{String(index + 1).padStart(2, "0")}</span><strong>{lab}</strong><StatusPill tone="blue">Department shared</StatusPill></div>)}</div>
      </Panel>
    </div>
  </div>;
}
