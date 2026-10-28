import { Clock3, ExternalLink, Mail, Phone, ShieldCheck, Users } from "lucide-react";
import { committeeContacts } from "../../data/mockStakeholderData";
import { PageHeader, Panel, SafeguardNote } from "../../components/stakeholder/PortalPrimitives";

export default function StatutoryCommitteesPage() {
  return <div className="stakeholder-page">
    <PageHeader eyebrow="PUBLIC HELP DIRECTORY" title="Statutory Committees & Help"
      description="Publicly disclosed contact information for student safety, grievance redressal, and equal opportunity support." />
    <SafeguardNote>These fictional contacts are for interface demonstration only. If you have an immediate safety emergency, contact local emergency services or an appropriate trusted authority.</SafeguardNote>
    <div className="stakeholder-contact-grid">{committeeContacts.map((committee) => <Panel key={committee.short} className="stakeholder-contact-card">
      <div className="stakeholder-contact-heading"><span><Users size={20} /></span><div><span className="stakeholder-contact-acronym">{committee.short}</span><h2>{committee.name}</h2></div></div>
      <p className="stakeholder-contact-detail">{committee.detail}</p>
      <div className="stakeholder-contact-lead"><strong>Contact person</strong><span>{committee.lead}</span></div>
      <div className="stakeholder-contact-line"><Mail size={15} /><a href={`mailto:${committee.email}`}>{committee.email}</a></div>
      <div className="stakeholder-contact-line"><Phone size={15} /><a href={`tel:${committee.phone.replace(/[^\d+]/g, "")}`}>{committee.phone}</a></div>
      <div className="stakeholder-contact-line"><Clock3 size={15} /><span>{committee.hours}</span></div>
      <a className="stakeholder-contact-more" href={`mailto:${committee.email}?subject=${encodeURIComponent("Demo information request")}`}>Contact directory <ExternalLink size={14} /></a>
    </Panel>)}</div>
    <Panel title="How to use this directory" description="Choose the committee whose published remit best matches your concern.">
      <div className="stakeholder-help-steps"><div><strong>01</strong><span>Review the listed committee scope and published contact channel.</span></div><div><strong>02</strong><span>Use the complaint form if you need a trackable demo reference.</span></div><div><strong>03</strong><span>Follow up through the committee or escalate through the designated official process.</span></div></div>
      <div className="stakeholder-inline-warning"><ShieldCheck size={16} />Committee contacts and all communications shown here are fictional demo information.</div>
    </Panel>
  </div>;
}
