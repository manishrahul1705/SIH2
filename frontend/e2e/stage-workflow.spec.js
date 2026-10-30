import { expect, test } from "@playwright/test";
import { signIn } from "./auth.js";

const apiOrigin = `http://127.0.0.1:${process.env.E2E_API_PORT || "4317"}/api/v1`;

async function api(page, method, path, body) {
  return page.evaluate(async ({ apiOrigin, method, path, body }) => {
    const response = await fetch(`${apiOrigin}${path}`, {
      method,
      credentials: "include",
      headers: method === "GET" ? {} : {
        "content-type": "application/json",
        "x-requested-with": "XMLHttpRequest",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, result: await response.json() };
  }, { apiOrigin, method, path, body });
}

test("institution application completes the allocated stages and peer-assist freeze cycle", async ({ browser, page }) => {
  const contexts = [];
  const openRolePage = async (email) => {
    const context = await browser.newContext();
    contexts.push(context);
    const rolePage = await context.newPage();
    await signIn(rolePage, email);
    return rolePage;
  };

  try {
    await signIn(page, "institution@approvaltrack.demo");
    const applicationTypes = await api(page, "GET", "/application-types");
    expect(applicationTypes.result.data.map(({ label }) => label)).toEqual([
      "New institution",
      "New course",
      "Increase in intake",
      "Extension of approval",
      "Conversion of diploma to degree",
      "Collaboration or twinning programme",
      "Restoration of intake",
    ]);
    const created = await api(page, "POST", "/applications", { applicationType: "new_institution" });
    expect(created.status, JSON.stringify(created.result)).toBe(201);
    const caseRecord = created.result.data;
    expect(caseRecord.allocatedStages[0].requiredDocuments).toContain("Fire Safety Certificate");
    const submitted = await api(page, "POST", `/cases/${caseRecord._id}/submit`, { expectedVersion: caseRecord.version });
    expect(submitted.status).toBe(200);
    const caseId = caseRecord._id;
    expect(submitted.result.data.case.allocatedStages.at(-1)).toMatchObject({
      key: "final_approval",
      assignedRole: "BUREAU_OFFICER",
    });

    const scrutinyPage = await openRolePage("scrutiny@approvaltrack.demo");
    await scrutinyPage.goto(`/case/${caseId}`);
    await expect(scrutinyPage.getByRole("heading", { name: "Stage review: Document Scrutiny" })).toBeVisible();
    await expect(scrutinyPage.locator(".stage-review-workspace")).toHaveCSS("display", "grid");
    await scrutinyPage.getByRole("button", { name: /Open alerts/ }).click();
    await expect(scrutinyPage.getByRole("dialog", { name: /Alerts/ })).toBeVisible();
    await scrutinyPage.getByRole("button", { name: "Close alerts" }).click();
    await scrutinyPage.getByLabel("Target role").selectOption("EVC");
    await scrutinyPage.getByLabel("Assign to").selectOption({ label: "Demo EVC Member · evc@approvaltrack.demo" });
    await scrutinyPage.getByLabel("Request note").fill("Verify the campus inspection evidence.");
    await scrutinyPage.getByRole("button", { name: "Request Help & Freeze Stage" }).click();
    await expect(scrutinyPage).toHaveURL(/\/cases$/);
    await expect(scrutinyPage.getByText("Frozen — assistance requested")).toBeVisible();

    const frozenCase = await api(scrutinyPage, "GET", `/cases/${caseId}`);
    const blockedApproval = await api(scrutinyPage, "POST", `/cases/${caseId}/stages/0/approve`, {
      expectedVersion: frozenCase.result.data.version,
    });
    expect(blockedApproval.status).toBe(403);
    expect(blockedApproval.result.error.code).toBe("STAGE_FROZEN");

    const evcPage = await openRolePage("evc@approvaltrack.demo");
    await evcPage.goto(`/case/${caseId}`);
    await expect(evcPage.getByRole("heading", { name: "Assistance assigned to you" })).toBeVisible();
    await evcPage.getByRole("button", { name: "Approve Assist Request" }).click();
    await expect(evcPage).toHaveURL(/\/cases$/);
    await expect(evcPage.getByText("Case not found in your scope")).toHaveCount(0);

    await scrutinyPage.goto(`/case/${caseId}`);
    await expect(scrutinyPage.getByText("Active — assistance complete").first()).toBeVisible();
    await expect(scrutinyPage.getByText("Assistance approved by Demo EVC Member")).toBeVisible();
    await scrutinyPage.getByRole("button", { name: "Approve Stage & Move to Next" }).click();
    await expect(scrutinyPage).toHaveURL(/\/cases$/);
    await scrutinyPage.goto(`/case/${caseId}`);
    await expect(scrutinyPage.getByRole("heading", { name: "Stage review: Infrastructure & Land/Lease Verification" })).toBeVisible();
    await scrutinyPage.getByRole("button", { name: "Approve Stage & Move to Next" }).click();
    await expect(scrutinyPage).toHaveURL(/\/cases$/);

    await evcPage.goto(`/case/${caseId}`);
    await expect(evcPage.getByRole("heading", { name: "Stage review: EVC Physical/Virtual Inspection" })).toBeVisible();
    await evcPage.getByRole("button", { name: "Approve Stage & Move to Next" }).click();
    await expect(evcPage).toHaveURL(/\/cases$/);

    const sacPage = await openRolePage("sac@approvaltrack.demo");
    await sacPage.goto(`/case/${caseId}`);
    await expect(sacPage.getByRole("heading", { name: "Stage review: SAC / Final Review" })).toBeVisible();
    await sacPage.getByRole("button", { name: "Approve Stage & Move to Next" }).click();
    await expect(sacPage).toHaveURL(/\/cases$/);

    const bureauPage = await openRolePage("bureau@approvaltrack.demo");
    const adminPage = await openRolePage("admin@approvaltrack.demo");
    const activeFinalStage = await api(bureauPage, "GET", `/cases/${caseId}`);
    const adminApproval = await api(adminPage, "POST", `/cases/${caseId}/stages/4/approve`, {
      expectedVersion: activeFinalStage.result.data.version,
    });
    expect(adminApproval.status).toBe(403);

    await bureauPage.goto("/bureau/approvals");
    await expect(bureauPage.getByRole("heading", { name: "Bureau Officer final approval queue" })).toBeVisible();
    await bureauPage.getByRole("link", { name: caseRecord.caseNo }).click();
    await expect(bureauPage.getByRole("heading", { name: "Stage review: Final Approval" })).toBeVisible();
    const { connectDatabase, disconnectDatabase } = await import("../../backend/src/models/db.js");
    const { AiExtraction, CaseObligation, CaseRecord, Document, NotificationJob, User } = await import("../../backend/src/models/index.js");
    await connectDatabase(process.env.MONGODB_URI);
    try {
      const institutionUser = await User.findOne({ email: "institution@approvaltrack.demo" }).select("_id").lean();
      const [document] = await Document.create([{
        case_id: caseId,
        uploaded_by: institutionUser._id,
        file_path: "e2e-placeholder.pdf",
        original_name: "Fire Safety Certificate.pdf",
        file_hash: `e2e-${caseId}`,
        mime: "application/pdf",
        doc_type_slot: "fire",
        doc_type_final: "Fire Safety Certificate",
        status: "CONFIRMED",
      }]);
      await AiExtraction.create([{
        document_id: document._id,
        fields: [{
          field_name: "valid_to",
          ai_value: "2027-10-29",
          ai_confidence: 0.99,
          zone: "GREEN",
          confirmed_value: "2027-10-29",
          confirmed_source: "manual",
          confirmed_by: institutionUser._id,
          confirmed_at: new Date(),
        }],
      }]);
      const savedCase = await CaseRecord.findById(caseId);
      const fireSlot = savedCase.slotRecords.find((slot) => slot.slotId === "fire")
        || savedCase.slotRecords.create({ slotId: "fire" });
      if (!savedCase.slotRecords.includes(fireSlot)) savedCase.slotRecords.push(fireSlot);
      fireSlot.documentId = document._id;
      fireSlot.status = "confirmed";
      await savedCase.save();
    } finally {
      await disconnectDatabase();
    }
    await bureauPage.reload();
    const extractedFields = bureauPage.getByRole("region", { name: "Extracted fields review" });
    await expect(extractedFields.getByText("Fire Safety Certificate", { exact: true })).toBeVisible();
    await expect(extractedFields.getByText(/CONFIRMED ·/)).toBeVisible();
    await extractedFields.getByRole("button", { name: "Edit / confirm fields" }).click();
    await extractedFields.getByLabel("valid to for Fire Safety Certificate.pdf").fill("2028-10-29");
    const confirmationResponsePromise = bureauPage.waitForResponse((response) =>
      response.url().includes("/confirm-fields") && response.request().method() === "PATCH");
    await extractedFields.getByRole("button", { name: "Save & confirm fields" }).click();
    const confirmationResponse = await confirmationResponsePromise;
    expect(confirmationResponse.status(), await confirmationResponse.text()).toBe(200);
    await expect(extractedFields.getByText("2028-10-29")).toBeVisible();
    await bureauPage.getByRole("button", { name: "Approve Application" }).click();
    await expect(bureauPage).toHaveURL(/\/cases$/);

    const finalCase = await api(bureauPage, "GET", `/cases/${caseId}`);
    expect(finalCase.result.data).toMatchObject({
      overallStatus: "FINAL_APPROVED",
      status: "approved",
      currentStageIndex: 4,
    });
    expect(finalCase.result.data.allocatedStages.every((stage) => stage.status === "APPROVED")).toBe(true);

    await connectDatabase(process.env.MONGODB_URI);
    try {
      const email = await NotificationJob.findOne({ dedupe_key: `final-approved:${caseId}:email` }).lean();
      const inApp = await NotificationJob.findOne({ dedupe_key: `final-approved:${caseId}:in_app` }).lean();
      const validity = await CaseObligation.findOne({ caseId, type: "validity", sourceDocumentId: { $ne: null } }).lean();
      expect(email.payload_json).toMatchObject({
        recipient_email: "contact1@approvaltrack.demo",
        subject: expect.stringContaining(caseRecord.caseNo),
      });
      expect(email.payload_json.body).toContain("Stage-by-stage approval summary");
      expect(email.payload_json.body).toContain("Fire Safety Certificate — valid to: 2028-10-29");
      expect(validity).toMatchObject({
        title: "Fire Safety Certificate validity",
        dueAt: new Date("2028-10-29T00:00:00.000Z"),
        type: "validity",
      });
      expect(inApp).not.toBeNull();
    } finally {
      await disconnectDatabase();
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
