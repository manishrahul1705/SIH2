import { PageHeader, Panel, SafeguardNote } from "../../components/stakeholder/PortalPrimitives";
import { useStakeholder } from "../../context/StakeholderContext";

export default function ComplaintsTrackerPage() {
  const { institution, loading, error } = useStakeholder();
  return <div className="stakeholder-page">
    <PageHeader eyebrow="COMPLAINT TRACKER" title="My Complaints & Tracker"
      description="Complaint history belonging to the signed-in user." />
    <Panel title="Complaint records unavailable">
      {loading ? <p>Loading account data...</p> : error ? <p role="alert">{error}</p> : <p>The backend currently has no complaint records or complaint API. No local or sample tickets are shown.</p>}
      {institution && <small>Institution: {institution.name}</small>}
    </Panel>
    <SafeguardNote tone="amber">Complaint submission and tracking are unavailable until a backend workflow is implemented. No ticket, escalation, or human review is being simulated.</SafeguardNote>
  </div>;
}
