import { ArrowDownToLine, Award, Building2, CalendarDays, CheckCircle2, FileText, MapPin, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { eoaHistory, institutionProfile, safetyCertificates } from "../../data/mockStakeholderData";
import { PageHeader, Panel, SafeguardNote, StatusPill } from "../../components/stakeholder/PortalPrimitives";
import { useStakeholder } from "../../context/StakeholderContext";

function downloadLetter(item) {
  const contents = [
    "ApprovalTrack fictional public disclosure",
    institutionProfile.name,
    `AICTE Permanent ID: ${institutionProfile.permanentId}`,
    `Academic year: ${item.year}`,
    `Status: ${item.status}`,
    `Issue date: ${item.date}`,
    "This demo summary is not an official AICTE approval letter.",
  ].join("\n");
  return `data:text/plain;charset=utf-8,${encodeURIComponent(contents)}`;
}

export default function CollegeOverviewPage() {
  const { role } = useStakeholder();
  const faculty = role === "faculty";
  return <div className="stakeholder-page">
    <PageHeader
      eyebrow="PUBLIC INSTITUTION PROFILE"
      title={faculty ? "College Overview & Offerings" : "College Overview & Approval"}
      description="Read-only view of the institution's published approval status, approved programmes, and compliance disclosures."
      action={<StatusPill>{institutionProfile.approvalStatus}</StatusPill>}
    />
    <div className="stakeholder-profile-hero">
      <div className="stakeholder-profile-icon"><Building2 size={26} /></div>
      <div className="stakeholder-profile-main">
        <p className="stakeholder-eyebrow">FICTIONAL DEMO INSTITUTION</p>
        <h2>{institutionProfile.name}</h2>
        <div className="stakeholder-inline-meta"><span><MapPin size={15} />{institutionProfile.location}</span><span><span className="meta-dot" />AICTE Permanent ID: <strong>{institutionProfile.permanentId}</strong></span></div>
      </div>
      <div className="stakeholder-profile-year"><span>ACADEMIC YEAR</span><strong>{institutionProfile.academicYear}</strong><small>Latest EoA · {institutionProfile.latestEoaDate}</small></div>
    </div>
    <div className="stakeholder-overview-metrics">
      <div className="stakeholder-overview-metric"><span>University affiliation</span><strong>{institutionProfile.affiliation}</strong></div>
      <div className="stakeholder-overview-metric"><span>Institution type</span><strong>{institutionProfile.type}</strong></div>
      <div className="stakeholder-overview-metric"><span>Accrediting bodies</span><strong>{institutionProfile.accreditingBodies.join(" · ")}</strong></div>
      {faculty && <div className="stakeholder-overview-metric"><span>Public faculty-student ratio</span><strong>{institutionProfile.facultyStudentRatio} <small>against {institutionProfile.requiredRatio} norm</small></strong></div>}
    </div>
    {faculty && <SafeguardNote>Institutional compliance snapshot is published disclosure only. It is not a verified finding and has no automatic Action Score or application-routing effect.</SafeguardNote>}
    <div className="stakeholder-two-column">
      <Panel title="Extension of Approval history" description="Demo summaries of public approval records by academic year.">
        <div className="stakeholder-eoa-list">
          {eoaHistory.map((item) => <div className="stakeholder-eoa-row" key={item.year}>
            <span className="stakeholder-eoa-icon"><FileText size={17} /></span>
            <div className="stakeholder-eoa-copy"><strong>{item.year} Extension of Approval</strong><small>{item.status} · issued {item.date}</small></div>
            <a className="stakeholder-icon-action" href={downloadLetter(item)} download={`demo-eoa-${item.year}.txt`} aria-label={`Download demo EoA summary for ${item.year}`}><ArrowDownToLine size={17} /></a>
          </div>)}
        </div>
        <p className="stakeholder-small-disclaimer">Downloadable items are fictional summaries, not official approval documents.</p>
      </Panel>
      <Panel title="Public statutory compliance" description="Verified status badges published in the demo profile; sensitive internal reference numbers are not shown.">
        <div className="stakeholder-compliance-list">
          {safetyCertificates.map((certificate) => <div className="stakeholder-compliance-row" key={certificate.name}>
            <div className="stakeholder-check-icon"><CheckCircle2 size={17} /></div>
            <div><strong>{certificate.name}</strong><small>{certificate.issuer} · valid to {certificate.expires}</small></div>
            <StatusPill>{certificate.status}</StatusPill>
          </div>)}
        </div>
      </Panel>
    </div>
    <div className="stakeholder-quick-links">
      <Link to={`/${role}/offerings`}><Award size={17} />View approved courses</Link>
      <Link to={`/${role}/facilities`}><ShieldCheck size={17} />View campus facilities</Link>
      {!faculty && <Link to="/student/committees"><CalendarDays size={17} />Committee contacts</Link>}
    </div>
  </div>;
}
