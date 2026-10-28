import { Building2, MapPin } from "lucide-react";
import { Link } from "react-router-dom";
import { PageHeader, Panel, SafeguardNote, StatusPill } from "../../components/stakeholder/PortalPrimitives";
import { useStakeholder } from "../../context/StakeholderContext";

function Display({ label, value }) {
  return <div className="stakeholder-overview-metric"><span>{label}</span><strong>{value === null || value === undefined || value === "" ? "Not recorded" : value}</strong></div>;
}

export default function CollegeOverviewPage() {
  const { role, institution, profile, loading, error } = useStakeholder();
  const faculty = role === "faculty";
  if (loading) return <div className="stakeholder-page"><PageHeader title="College Overview" /><Panel title="Loading institution data">Loading from ApprovalTrack...</Panel></div>;
  if (error) return <div className="stakeholder-page"><PageHeader title="College Overview" /><Panel title="Unable to load institution data"><p role="alert">{error}</p></Panel></div>;
  if (!institution) return <div className="stakeholder-page"><PageHeader title="College Overview" /><Panel title="Institution not linked"><p>Your account is not linked to an institution profile.</p></Panel></div>;

  return <div className="stakeholder-page">
    <PageHeader eyebrow="INSTITUTION RECORD" title={faculty ? "College Overview" : "College Overview & Approval"}
      description="Institution information and record counts returned for your authenticated institution." />
    <div className="stakeholder-profile-hero">
      <div className="stakeholder-profile-icon"><Building2 size={26} /></div>
      <div className="stakeholder-profile-main">
        <p className="stakeholder-eyebrow">BACKEND INSTITUTION RECORD</p>
        <h2>{institution.name}</h2>
        <div className="stakeholder-inline-meta"><span><MapPin size={15} />{institution.state || "State not recorded"}</span><span>AICTE Permanent ID: <strong>{institution.aicte_id || "Not recorded"}</strong></span></div>
      </div>
      <div className="stakeholder-profile-year"><span>STATUS</span><strong><StatusPill>{institution.status}</StatusPill></strong><small>{institution.region || "Region not recorded"}</small></div>
    </div>
    <div className="stakeholder-overview-metrics">
      <Display label="Contact email" value={institution.contact_email} />
      <Display label="Contact phone" value={institution.contact_phone} />
      <Display label="Applications in system" value={institution.counts?.applications} />
      {faculty && <Display label="Active faculty records" value={institution.counts?.activeFaculty} />}
      {!faculty && <Display label="Active student records" value={institution.counts?.activeStudents} />}
    </div>
    <SafeguardNote>Only fields present in the backend institution record are shown. Programmes, approval letters, safety certificates, and other disclosures are not represented here unless they exist as backend records.</SafeguardNote>
    <Panel title="Published records" description="No course catalog, facilities, committee directory, or approval-history endpoint is currently connected to this portal.">
      <p>These disclosures are unavailable because the backend does not currently store them.</p>
      <div className="stakeholder-quick-links">
        <Link to={`/${role}/offerings`}>Course offerings</Link>
        <Link to={`/${role}/facilities`}>Campus facilities</Link>
        {!faculty && <Link to="/student/committees">Committee contacts</Link>}
      </div>
      <p>{faculty ? `Signed-in faculty profile: ${profile?.name || "Not recorded"} · ${profile?.department || "Department not recorded"}` : `Signed-in student profile: ${profile?.name || "Not recorded"} · ${profile?.programme || "Programme not recorded"}`}</p>
    </Panel>
  </div>;
}
