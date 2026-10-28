import { PageHeader, Panel, SafeguardNote } from "../../components/stakeholder/PortalPrimitives";
import { useStakeholder } from "../../context/StakeholderContext";

export default function StatutoryCommitteesPage() {
  const { institution, loading, error } = useStakeholder();
  return <div className="stakeholder-page">
    <PageHeader eyebrow="INSTITUTION CONTACTS" title="Statutory Committees & Help"
      description={institution ? `Verified contacts for ${institution.name}.` : "Institutional committee and support contacts."} />
    <Panel title="Committee directory unavailable">
      {loading ? <p>Loading institution data...</p> : error ? <p role="alert">{error}</p> : <p>The backend currently has no committee directory, so no contact details can be shown.</p>}
    </Panel>
    <SafeguardNote tone="amber">For an immediate emergency, contact local emergency services or a trusted authority. Do not rely on an unverified contact listed in this portal.</SafeguardNote>
  </div>;
}
