import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader, Panel, StatusPill } from "../../components/stakeholder/PortalPrimitives";
import { stakeholderApi } from "../../services/stakeholder";

const initialNotice = { title: "", body: "", source_url: "", category: "NOTICE", audience: "ALL", published: false };

export default function GovernancePage() {
  const [announcements, setAnnouncements] = useState([]);
  const [notice, setNotice] = useState(initialNotice);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const notices = await stakeholderApi.getAnnouncements();
    setAnnouncements(notices || []);
  }

  useEffect(() => { load().catch((loadError) => setError(loadError.message)); }, []);

  async function publish(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await stakeholderApi.createAnnouncement(notice);
      setNotice(initialNotice);
      await load();
    } catch (saveError) { setError(saveError.message); }
    finally { setBusy(false); }
  }

  return <div className="page-container page-shell-wide">
    <PageHeader eyebrow="ADMINISTRATION" title="Announcements & complaints" description="Publish administrator-authored notices with an optional source link and review authenticated stakeholder complaints." />
    {error && <p className="state-card state-error" role="alert">{error}</p>}
    <Panel title="Create an announcement" description="Drafts remain private. Published items appear to the selected audience after their publish date.">
      <form className="stakeholder-form-grid" onSubmit={publish}>
        <label className="stakeholder-field stakeholder-field-full">Title<input required minLength={5} maxLength={180} value={notice.title} onChange={(e) => setNotice({ ...notice, title: e.target.value })} /></label>
        <label className="stakeholder-field">Type<select value={notice.category} onChange={(e) => setNotice({ ...notice, category: e.target.value })}><option value="NOTICE">Notice</option><option value="CIRCULAR">Circular</option><option value="UPDATE">Update</option></select></label>
        <label className="stakeholder-field">Audience<select value={notice.audience} onChange={(e) => setNotice({ ...notice, audience: e.target.value })}><option value="ALL">Students and faculty</option><option value="STUDENT">Students</option><option value="FACULTY">Faculty</option></select></label>
        <label className="stakeholder-field stakeholder-field-full">Content<textarea required minLength={10} maxLength={10000} rows={5} value={notice.body} onChange={(e) => setNotice({ ...notice, body: e.target.value })} /></label>
        <label className="stakeholder-field stakeholder-field-full">Source URL (optional)<input type="url" maxLength={2048} placeholder="https://aicte-india.org/..." value={notice.source_url} onChange={(e) => setNotice({ ...notice, source_url: e.target.value })} /></label>
        <label className="stakeholder-field-full stakeholder-checkbox-field">
          <input type="checkbox" checked={notice.published} onChange={(e) => setNotice({ ...notice, published: e.target.checked })} />
          <span>Publish now</span>
        </label>
        <div className="stakeholder-field-full"><button className="stakeholder-button primary" disabled={busy}>{busy ? "Saving…" : "Save announcement"}</button></div>
      </form>
    </Panel>
    <Panel title="Recent announcements">
      {announcements.length ? announcements.map((item) => <p key={item._id}><StatusPill tone={item.published ? "green" : "slate"}>{item.published ? "PUBLISHED" : "DRAFT"}</StatusPill> <strong>{item.title}</strong> · {item.audience}{item.source_url && <> · <a href={item.source_url} target="_blank" rel="noreferrer">Source</a></>}</p>) : <p>No announcements created yet.</p>}
    </Panel>
    <Panel title="College grievance redressal" description="Review and forward complaints through the dedicated identity-protected AICTE workflow.">
      <p>New complaints are grouped by college, with complainant identities protected from institutions.</p>
      <Link className="stakeholder-button primary" to="/admin/grievances">Open College Grievances</Link>
    </Panel>
  </div>;
}
