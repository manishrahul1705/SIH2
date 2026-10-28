import { PageHeader, Panel } from "../../components/stakeholder/PortalPrimitives";
import { useStakeholder } from "../../context/StakeholderContext";

export default function DepartmentRosterPage() {
  const { faculty, loading, error } = useStakeholder();
  return <div className="stakeholder-page">
    <PageHeader eyebrow="FACULTY PROFILE" title="Department & Cadre Roster"
      description="Your own faculty record from the backend. No institution-wide roster or cadre totals are currently available." />
    <Panel title="Your faculty profile">
      {loading ? <p>Loading faculty profile...</p> : error ? <p role="alert">{error}</p> : faculty ? <dl>
        <dt>Name</dt><dd>{faculty.name || "Not recorded"}</dd>
        <dt>Employee ID</dt><dd>{faculty.employee_id || "Not recorded"}</dd>
        <dt>Department</dt><dd>{faculty.department || "Not recorded"}</dd>
        <dt>Designation</dt><dd>{faculty.designation || "Not recorded"}</dd>
        <dt>Qualification</dt><dd>{faculty.qualification || "Not recorded"}</dd>
        <dt>Status</dt><dd>{faculty.status || "Not recorded"}</dd>
      </dl> : <p>No faculty profile is linked to this account.</p>}
    </Panel>
  </div>;
}
