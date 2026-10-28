import { PageHeader, Panel, SafeguardNote } from "../../components/stakeholder/PortalPrimitives";
import { useStakeholder } from "../../context/StakeholderContext";

export default function CampusFacilitiesPage() {
  const { institution, loading, error } = useStakeholder();
  return <div className="stakeholder-page">
    <PageHeader eyebrow="CAMPUS DISCLOSURES" title="Campus Facilities & Safety"
      description={institution ? `Facilities for ${institution.name}.` : "Institution facilities and safety information."} />
    <Panel title="Facilities data unavailable">
      {loading ? <p>Loading institution data...</p> : error ? <p role="alert">{error}</p> : <p>The backend currently has no facilities or safety-certificate records to display.</p>}
    </Panel>
    <SafeguardNote tone="amber">No facility count, certificate, or safety status is assumed. Information will be shown when it is available from the backend.</SafeguardNote>
  </div>;
}
