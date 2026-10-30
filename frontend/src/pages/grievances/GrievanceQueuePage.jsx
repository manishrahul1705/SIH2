import { useEffect, useState } from "react";
import { PageHeader, Panel, StatusPill } from "../../components/stakeholder/PortalPrimitives";
import { useAppStore } from "../../store/useAppStore";
import { stakeholderApi } from "../../services/stakeholder";

export default function GrievanceQueuePage() {
  const role = useAppStore((state) => state.role);
  const isOmbudsperson = ["Ombudsperson", "University/DTE Officer"].includes(role);
  const [complaints, setComplaints] = useState([]);
  const [error, setError] = useState("");

  async function load() {
    setError("");
    try { setComplaints(await stakeholderApi.getComplaints() || []); }
    catch (loadError) { setError(loadError.message); }
  }

  useEffect(() => { load(); }, []);

  async function updateComplaint(complaint, status) {
    const resolution_note = window.prompt("Record the official written update:");
    if (!resolution_note) return;
    try {
      await stakeholderApi.updateComplaint(complaint._id, { status, resolution_note });
      await load();
    } catch (updateError) { setError(updateError.message); }
  }

  async function updateAppeal(complaint, status) {
    const resolution_note = window.prompt("Record the Ombudsperson's written decision or update:");
    if (!resolution_note) return;
    try {
      await stakeholderApi.updateAppeal(complaint._id, { status, resolution_note });
      await load();
    } catch (updateError) { setError(updateError.message); }
  }

  async function downloadEvidence(complaint, evidence) {
    setError("");
    try {
      const blob = await stakeholderApi.downloadComplaintEvidence(complaint._id, evidence._id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = evidence.file_name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (downloadError) { setError(downloadError.message); }
  }

  return <div className="page-container">
    <PageHeader eyebrow={isOmbudsperson ? "GRIEVANCE APPEALS" : "INSTITUTION GRIEVANCE CELL"} title={role === "University/DTE Officer" ? "University/DTE appeal queue" : isOmbudsperson ? "Ombudsperson appeal queue" : "Grievance review queue"} description={isOmbudsperson ? "Review appeals routed to your regional account. Student Ombudsperson decisions have a 30-day target; faculty/staff University/DTE appeal periods are not set here where the regulation gives no duration." : "Review complaints assigned to your institution grievance officer. Student SGRC and faculty/staff GRC cases are kept distinct."} />
    <Panel title={isOmbudsperson ? "Assigned appeals" : "Assigned grievances"} description="Only records assigned to the signed-in officer are returned by the server.">
      {error && <p className="login-error" role="alert">{error}</p>}
      {complaints.length ? <div className="stakeholder-report-list">{complaints.map((complaint) => <article className="stakeholder-report-card" key={complaint._id}>
        <div className="stakeholder-report-copy">
          <div><strong>{complaint.subject}</strong><StatusPill tone={["RESOLVED", "REJECTED"].includes(isOmbudsperson ? complaint.appeal_status : complaint.status) ? "green" : "amber"}>{isOmbudsperson ? complaint.appeal_status : complaint.status}</StatusPill></div>
          <p>{complaint.complainant_role} · {complaint.committee_type?.replaceAll("_", " ")} · {complaint.category.replaceAll("_", " ")}</p>
          <p>{complaint.description}</p>
          <small>Institution {complaint.institution_id} · First-stage due {new Date(complaint.response_due_at).toLocaleDateString()}{complaint.appeal_due_at ? ` · Appeal due ${new Date(complaint.appeal_due_at).toLocaleDateString()}` : ""}</small>
          <div className="stakeholder-evidence-list"><strong>Evidence:</strong> {complaint.evidence?.length ? complaint.evidence.map((file) => <button className="stakeholder-button secondary small" key={file._id} onClick={() => downloadEvidence(complaint, file)}>{file.file_name}</button>) : "None attached"}</div>
          <label className="stakeholder-field">{isOmbudsperson ? "Appeal status" : "Grievance status"}
            <select value={isOmbudsperson ? complaint.appeal_status : complaint.status} onChange={(event) => isOmbudsperson ? updateAppeal(complaint, event.target.value) : updateComplaint(complaint, event.target.value)}>
              {(isOmbudsperson ? ["SUBMITTED", "IN_REVIEW", "RESOLVED", "REJECTED"] : ["SUBMITTED", "ACKNOWLEDGED", "IN_REVIEW", "RESOLVED", "REJECTED"]).map((status) => <option key={status}>{status}</option>)}
            </select>
          </label>
        </div>
      </article>)}</div> : !error && <div className="stakeholder-empty"><strong>No assigned records</strong><p>There are no grievances or appeals currently assigned to this account.</p></div>}
      <button className="stakeholder-button secondary small" onClick={load}>Refresh queue</button>
    </Panel>
  </div>;
}
