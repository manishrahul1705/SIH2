import { describe, expect, it } from "vitest";
import { announcementScopeFor, canTransitionAppeal, canTransitionComplaint, complaintScopeFor, safeInstitutionComplaint } from "../src/modules/stakeholders/router.js";

describe("stakeholder access scopes", () => {
  it("limits complainants to their own records and grants the review queue only to admins", () => {
    const user = { _id: "student-id", role: "STUDENT" };
    expect(complaintScopeFor(user)).toEqual({ complainant_id: "student-id" });
    expect(complaintScopeFor({ role: "ADMIN" })).toEqual({});
    expect(complaintScopeFor({ _id: "grievance-id", role: "GRIEVANCE_OFFICER" })).toEqual({ assigned_to: "grievance-id" });
    expect(complaintScopeFor({ _id: "institution-user", institution_id: "college-id", role: "INSTITUTION" })).toEqual({
      institution_id: "college-id",
      status: { $in: ["ACKNOWLEDGED_SENT_TO_COLLEGE", "COLLEGE_REPLIED", "RESOLVED"] },
    });
    expect(complaintScopeFor({ _id: "ombudsman-id", role: "OMBUDSPERSON" })).toEqual({ appeal_assigned_to: "ombudsman-id", appeal_status: { $in: ["SUBMITTED", "IN_REVIEW"] } });
    expect(complaintScopeFor({ _id: "appeal-id", role: "UNIVERSITY_DTE_OFFICER" })).toEqual({ appeal_assigned_to: "appeal-id", appeal_status: { $in: ["SUBMITTED", "IN_REVIEW"] } });
  });

  it("allows only forward complaint decisions and does not reopen terminal cases", () => {
    expect(canTransitionComplaint("PENDING_ADMIN_VALIDATION", "ACKNOWLEDGED_SENT_TO_COLLEGE")).toBe(true);
    expect(canTransitionComplaint("ACKNOWLEDGED_SENT_TO_COLLEGE", "COLLEGE_REPLIED")).toBe(true);
    expect(canTransitionComplaint("COLLEGE_REPLIED", "RESOLVED")).toBe(true);
    expect(canTransitionComplaint("SUBMITTED", "ACKNOWLEDGED")).toBe(true);
    expect(canTransitionComplaint("ACKNOWLEDGED", "IN_REVIEW")).toBe(true);
    expect(canTransitionComplaint("IN_REVIEW", "RESOLVED")).toBe(true);
    expect(canTransitionComplaint("SUBMITTED", "RESOLVED")).toBe(false);
    expect(canTransitionComplaint("RESOLVED", "IN_REVIEW")).toBe(false);
  });

  it("removes complainant identifiers and actor metadata from institution complaint responses", () => {
    const result = safeInstitutionComplaint({
      _id: "complaint-id",
      complaint_id: "GRV-001",
      complainant_id: { _id: "person-id", name: "Private Name", email: "private@example.test" },
      complainant_role: "STUDENT",
      institution_id: "college-id",
      category: "FEES",
      subject: "Fee grievance from Private Name",
      description: "Contact private@example.test about the issue. Student number STU7788.",
      status: "ACKNOWLEDGED_SENT_TO_COLLEGE",
      assigned_to: "officer-id",
      admin_action: { acknowledged_by: "admin-id", admin_remarks: "Please investigate", response_deadline: new Date() },
      evidence: [{ _id: "file-id", file_name: "Private Name STU7788.pdf", mime_type: "application/pdf", uploaded_by: "person-id", storage_path: "private/path" }],
      college_response: { proof_document: { _id: "atr-file-id", file_name: "atr.pdf", uploaded_by: "college-user", storage_path: "private/atr" } },
      history: [{ status: "SUBMITTED", note: "Private internal note", actor_id: "person-id" }],
    }, ["Private Name", "private@example.test", "STU7788"]);

    expect(result).not.toHaveProperty("complainant_id");
    expect(result).not.toHaveProperty("complainant_role");
    expect(result).not.toHaveProperty("assigned_to");
    expect(result.admin_action).not.toHaveProperty("acknowledged_by");
    expect(result.evidence[0]).not.toHaveProperty("uploaded_by");
    expect(result.evidence[0]).not.toHaveProperty("storage_path");
    expect(result.evidence[0].file_name).toBe("Evidence 1.pdf");
    expect(result.college_response.proof_document).not.toHaveProperty("uploaded_by");
    expect(result.college_response.proof_document).not.toHaveProperty("storage_path");
    expect(result.subject).not.toContain("Private Name");
    expect(result.description).not.toContain("private@example.test");
    expect(result.description).not.toContain("STU7788");
    expect(result).not.toHaveProperty("history");
    expect(result.anonymous_alias).toMatch(/^Anonymous Student #STU-/);
  });

  it("requires appeals to enter review before a terminal decision", () => {
    expect(canTransitionAppeal("SUBMITTED", "IN_REVIEW")).toBe(true);
    expect(canTransitionAppeal("IN_REVIEW", "RESOLVED")).toBe(true);
    expect(canTransitionAppeal("SUBMITTED", "RESOLVED")).toBe(false);
    expect(canTransitionAppeal("RESOLVED", "IN_REVIEW")).toBe(false);
  });

  it("restricts feeds to published, in-date notices for the signed-in audience", () => {
    const now = new Date("2026-10-29T00:00:00Z");
    expect(announcementScopeFor({ role: "FACULTY" }, now)).toEqual({
      published: true,
      publish_at: { $lte: now },
      $or: [{ expires_at: null }, { expires_at: { $gt: now } }],
      audience: { $in: ["ALL", "FACULTY"] },
    });
    expect(announcementScopeFor({ role: "ADMIN" }, now)).toEqual({});
  });
});
