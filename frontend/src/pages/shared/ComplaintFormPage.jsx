import { PageHeader, Panel, SafeguardNote } from "../../components/stakeholder/PortalPrimitives";
import { useStakeholder } from "../../context/StakeholderContext";

export default function ComplaintFormPage() {
  const { institution, loading, error } = useStakeholder();
  return <div className="stakeholder-page">
    <PageHeader eyebrow="COMPLAINT SUPPORT" title="Lodge a Complaint"
      description="Complaint submissions must be persisted and tracked by the backend." />
    <Panel title="Complaint submission unavailable">
      {loading ? <p>Loading account data...</p> : error ? <p role="alert">{error}</p> : <p>The backend currently has no complaint submission workflow. This form is disabled rather than creating a local-only ticket.</p>}
      {institution && <small>Institution: {institution.name}</small>}
    </Panel>
    <SafeguardNote tone="amber">Do not submit sensitive information here until an authenticated backend complaint workflow is available. For immediate emergencies, contact local emergency services or an appropriate trusted authority.</SafeguardNote>
  </div>;
}
