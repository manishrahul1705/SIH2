import { GraduationCap } from "lucide-react";
import { PageHeader, Panel, SafeguardNote } from "../../components/stakeholder/PortalPrimitives";
import { useStakeholder } from "../../context/StakeholderContext";

export default function ApprovedOfferingsPage() {
  const { institution, loading, error } = useStakeholder();
  return <div className="stakeholder-page">
    <PageHeader eyebrow="COURSE OFFERINGS" title="Approved Courses & Offerings"
      description={institution ? `Institution: ${institution.name}.` : "Institution course catalog."} />
    <Panel title="Course catalog unavailable">
      {loading ? <p>Loading institution data...</p> : error ? <p role="alert">{error}</p> : <p>The backend currently has no approved-programme catalog endpoint. No course data is being displayed as approved.</p>}
      <GraduationCap size={24} aria-hidden="true" />
    </Panel>
    <SafeguardNote tone="amber">Course and intake information will appear here only after it is stored and served by the backend.</SafeguardNote>
  </div>;
}
