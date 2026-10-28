import { Accessibility, BookOpen, Building, Computer, Hospital, LibraryBig, ShieldCheck, Wifi } from "lucide-react";
import { facilities, safetyCertificates } from "../../data/mockStakeholderData";
import { PageHeader, Panel, StatusPill } from "../../components/stakeholder/PortalPrimitives";

export default function CampusFacilitiesPage() {
  return <div className="stakeholder-page">
    <PageHeader eyebrow="PUBLIC CAMPUS DISCLOSURE" title="Campus Facilities & Safety"
      description="Published campus facilities and current safety-status badges. No sensitive internal certificate numbers are displayed." />
    <div className="stakeholder-facility-highlight">
      <div className="stakeholder-facility-icon"><Building size={23} /></div>
      <div><span>INSTRUCTIONAL BUILT-UP AREA</span><strong>{facilities.area}</strong><small>Institution-reported public disclosure</small></div>
      <StatusPill><ShieldCheck size={14} />Disclosure available</StatusPill>
    </div>
    <div className="stakeholder-facility-grid">
      <Panel title="Department laboratories" description="Published lab count by department." className="stakeholder-span-2">
        <div className="stakeholder-lab-grid">{facilities.laboratories.map((lab) => <div className="stakeholder-lab-card" key={lab.department}>
          <div className="stakeholder-lab-heading"><span className="stakeholder-facility-small-icon"><Computer size={17} /></span><strong>{lab.department}</strong></div>
          <div className="stakeholder-lab-count"><strong>{lab.count}</strong><span>laboratories</span></div>
          <StatusPill>{lab.status}</StatusPill>
        </div>)}</div>
      </Panel>
      <Panel title="Central library" description="Library and digital access." className="stakeholder-facility-detail">
        <div className="stakeholder-facility-row"><LibraryBig size={18} /><span>Volumes</span><strong>{facilities.library.volumes}</strong></div>
        <div className="stakeholder-facility-row"><BookOpen size={18} /><span>Journals</span><strong>{facilities.library.journals}</strong></div>
        <div className="stakeholder-facility-row"><Wifi size={18} /><span>E-consortium</span><strong>{facilities.library.consortium}</strong></div>
      </Panel>
      <Panel title="Computing & internet" description="Shared campus resources.">
        <div className="stakeholder-facility-pair"><div><Computer size={19} /><strong>{facilities.computing.terminals}</strong><span>computing terminals</span></div><div><Wifi size={19} /><strong>{facilities.computing.bandwidth}</strong><span>published bandwidth</span></div></div>
      </Panel>
      <Panel title="Hostel, mess & medical" description="Student support facilities.">
        <div className="stakeholder-facility-pair"><div><Building size={19} /><strong>{facilities.hostel.capacity}</strong><span>hostel capacity</span></div><div><Hospital size={19} /><strong>First aid</strong><span>{facilities.medical}</span></div></div>
        <p className="stakeholder-small-disclaimer">{facilities.hostel.mess}</p>
      </Panel>
      <Panel title="Barrier-free environment" description="Declared accessibility provisions.">
        <ul className="stakeholder-access-list">{facilities.accessibility.map((item) => <li key={item}><Accessibility size={16} />{item}</li>)}</ul>
      </Panel>
      <Panel title="Safety certificate snapshot" description="Public validity status only.">
        <div className="stakeholder-certificate-table">{safetyCertificates.map((certificate) => <div className="stakeholder-certificate-row" key={certificate.name}>
          <div><strong>{certificate.name}</strong><small>Valid through {certificate.expires}</small></div><StatusPill>{certificate.status}</StatusPill>
        </div>)}</div>
      </Panel>
    </div>
  </div>;
}
