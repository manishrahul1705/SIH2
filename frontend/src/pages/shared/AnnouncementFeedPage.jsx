import { useStakeholder } from "../../context/StakeholderContext";
import { EmptyState, PageHeader, Panel, StatusPill } from "../../components/stakeholder/PortalPrimitives";

export default function AnnouncementFeedPage() {
  const { announcements, loading, error } = useStakeholder();
  return <div className="stakeholder-page">
    <PageHeader eyebrow="ADMIN-PUBLISHED NOTICES" title="Announcements & Circulars" description="Notices published by ApprovalTrack administrators. This feed is not automatically synchronized with AICTE." />
    <Panel title="Published announcements" description="Only current announcements published for your portal role are shown. Follow the source link to verify the original notice.">
      {loading ? <p>Loading announcements…</p> : error ? <p role="alert">{error}</p> : announcements.length
        ? <div className="stakeholder-report-list">{announcements.map((item) => <article className="stakeholder-report-card" key={item._id}>
          <div className="stakeholder-report-icon">!</div>
          <div className="stakeholder-report-copy"><div><strong>{item.title}</strong><StatusPill tone="blue">{item.category}</StatusPill></div>
            <p className="stakeholder-announcement-body">{item.body}</p>
            {item.source_url && <a href={item.source_url} target="_blank" rel="noreferrer">Open source notice</a>}
            <small>Published {new Date(item.publish_at).toLocaleString()}</small>
          </div>
        </article>)}</div>
        : <EmptyState title="No published announcements" detail="There are no current notices for this portal. No sample announcements are shown." />}
    </Panel>
  </div>;
}
