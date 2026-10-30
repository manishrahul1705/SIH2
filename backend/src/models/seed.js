import argon2 from "argon2";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "./db.js";
import {
  Application,
  Policy,
  Document,
  Faculty,
  Institution,
  LeaseDetail,
  Student,
  StageConfig,
  User,
} from "./index.js";
import { logger } from "../config/logger.js";
import { CHECKLIST_SLOTS, APPLICATION_TYPES } from "../engine/checklist.js";
import { buildCaseRoute } from "../engine/routes.js";
import { DEFAULT_ALERT_RULES, DEFAULT_SCORE_WEIGHTS, DEFAULT_STAGE_COMPLETION } from "../engine/policyDefaults.js";

const demoPassword = process.env.DEMO_PASSWORD || "ApprovalTrack-Demo-2026!";
const sampleInstitutions = [
  { aicte_id: "DEMO-SI-001", name: "National Institute of Technology Demo", state: "Tamil Nadu", region: "Southern" },
  { aicte_id: "DEMO-SI-002", name: "Coastal Engineering College", state: "Kerala", region: "Southern" },
  { aicte_id: "DEMO-WI-003", name: "Western Applied Sciences Institute", state: "Maharashtra", region: "Western" },
];

const demoAccounts = [
  ["institution@approvaltrack.demo", "INSTITUTION", "Demo Institution Officer", "DEMO-SI-001"],
  ["scrutiny@approvaltrack.demo", "SCRUTINY_OFFICER", "Demo Scrutiny Officer", null],
  ["evc@approvaltrack.demo", "EVC", "Demo EVC Member", null],
  ["evc-chairman@approvaltrack.demo", "EVC_CHAIRMAN", "Demo EVC Chairman", null],
  ["sac@approvaltrack.demo", "SAC_SHC", "Demo SAC/SHC Member", null],
  ["bureau@approvaltrack.demo", "BUREAU_OFFICER", "Demo Bureau Officer", null],
  ["senior@approvaltrack.demo", "SENIOR_AUTHORITY", "Demo Senior Authority", null],
  ["admin@approvaltrack.demo", "ADMIN", "Demo Administrator", null],
  ["student@approvaltrack.demo", "STUDENT", "Demo Student", "DEMO-SI-001"],
  ["faculty@approvaltrack.demo", "FACULTY", "Demo Faculty Member", "DEMO-SI-001"],
  ["grievance@approvaltrack.demo", "GRIEVANCE_OFFICER", "Demo Grievance Officer", "DEMO-SI-001"],
  ["ombudsperson@approvaltrack.demo", "OMBUDSPERSON", "Demo Ombudsperson", null],
  ["university-dte@approvaltrack.demo", "UNIVERSITY_DTE_OFFICER", "Demo University/DTE Officer", null],
];

function daysFromToday(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

export async function seedDatabase() {
  await connectDatabase();
  try {
    const institutions = await Promise.all(sampleInstitutions.map((institution, index) => Institution.findOneAndUpdate(
      { aicte_id: institution.aicte_id },
      {
        $set: {
          ...institution,
          contact_email: `contact${index + 1}@approvaltrack.demo`,
          contact_phone: `+91990000000${index + 1}`,
          status: "ACTIVE",
          deleted_at: null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )));
    const institutionByCode = new Map(institutions.map((item) => [item.aicte_id, item]));
    const passwordHash = await argon2.hash(demoPassword, { type: argon2.argon2id });
    const users = await Promise.all(demoAccounts.map(([email, role, name, institutionCode]) => User.findOneAndUpdate(
      { email },
      {
        $set: {
          role,
          name,
          password_hash: passwordHash,
          institution_id: institutionCode ? institutionByCode.get(institutionCode)._id : null,
          phone: "+919900000001",
          status: "ACTIVE",
          region: institutionCode ? institutionByCode.get(institutionCode).region : "Southern",
          email_verified_at: new Date(),
          deleted_at: null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
    )));
    const userByRole = new Map(users.map((user) => [user.role, user]));

    const policyRoutes = Object.fromEntries(APPLICATION_TYPES.map((type) => [type, buildCaseRoute(type)]));
    const policyDefaults = {
      routes: policyRoutes,
      checklist: CHECKLIST_SLOTS,
      stageCompletion: DEFAULT_STAGE_COMPLETION,
      alertRules: DEFAULT_ALERT_RULES,
      scoreWeights: DEFAULT_SCORE_WEIGHTS,
      blockSubmitOnMissing: false,
      notes: "Seed configuration; checklist matrix, route choices, time windows and score weights are assumptions to verify against the final handbook.",
    };
    for (const [version, status, signedOffAt] of [
      ["v2026.1", "retired", new Date("2026-09-01T00:00:00.000Z")],
      ["v2026.2", "signed_off", new Date("2026-10-26T00:00:00.000Z")],
      ["v2026.3", "draft", null],
    ]) {
      await Policy.findOneAndUpdate(
        { version },
        { $setOnInsert: {
          ...policyDefaults,
          version,
          status,
          signedOffBy: signedOffAt ? userByRole.get("ADMIN")._id : null,
          signedOffAt,
        } },
        { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
      );
    }

    const applicationSamples = [
      { application_number: "AT-DEMO-2026-001", institution_id: institutions[0]._id, type: "EXTENSION_OF_APPROVAL", current_stage: "SCRUTINY", status: "IN_PROGRESS", assigned_officer_id: userByRole.get("SCRUTINY_OFFICER")._id, is_compliant: true },
      { application_number: "AT-DEMO-2026-002", institution_id: institutions[1]._id, type: "NEW", current_stage: "EVC", status: "IN_PROGRESS", assigned_officer_id: userByRole.get("SCRUTINY_OFFICER")._id, is_compliant: true },
      { application_number: "AT-DEMO-2026-003", institution_id: institutions[2]._id, type: "INCREASE_INTAKE", current_stage: "SAC_SHC", status: "IN_PROGRESS", assigned_officer_id: userByRole.get("SCRUTINY_OFFICER")._id, is_compliant: true },
      { application_number: "AT-DEMO-2026-004", institution_id: institutions[0]._id, type: "NEW_COURSE", current_stage: "DECISION", status: "IN_PROGRESS", assigned_officer_id: userByRole.get("ADMIN")._id, is_compliant: false },
      { application_number: "AT-DEMO-2026-005", institution_id: institutions[1]._id, type: "EXTENSION_OF_APPROVAL", current_stage: "SCRUTINY", status: "IN_PROGRESS", assigned_officer_id: userByRole.get("SCRUTINY_OFFICER")._id, is_compliant: true },
    ];
    const applications = await Promise.all(applicationSamples.map((sample) => Application.findOneAndUpdate(
      { application_number: sample.application_number },
      { $set: { ...sample, academic_year: "2026-27", stage_entered_at: daysFromToday(-2) } },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
    )));
    const stageDefaults = {
      NEW: [["SCRUTINY", "SCRUTINY_OFFICER", 0, 10], ["RE_SCRUTINY", "SCRUTINY_OFFICER", 1, 7], ["EVC", "EVC", 2, 15], ["SAC_SHC", "SAC_SHC", 3, 10], ["DECISION", "ADMIN", 4, 7]],
      EXTENSION_OF_APPROVAL: [["SCRUTINY", "SCRUTINY_OFFICER", 0, 10], ["RE_SCRUTINY", "SCRUTINY_OFFICER", 1, 7], ["DECISION", "ADMIN", 2, 7]],
      INCREASE_INTAKE: [["SCRUTINY", "SCRUTINY_OFFICER", 0, 10], ["RE_SCRUTINY", "SCRUTINY_OFFICER", 1, 7], ["EVC", "EVC", 2, 15], ["SAC_SHC", "SAC_SHC", 3, 10], ["DECISION", "ADMIN", 4, 7]],
      NEW_COURSE: [["SCRUTINY", "SCRUTINY_OFFICER", 0, 10], ["RE_SCRUTINY", "SCRUTINY_OFFICER", 1, 7], ["EVC", "EVC", 2, 15], ["SAC_SHC", "SAC_SHC", 3, 10], ["DECISION", "ADMIN", 4, 7]],
      CLOSURE: [["SCRUTINY", "SCRUTINY_OFFICER", 0, 10], ["DECISION", "ADMIN", 1, 7]],
    };
    for (const [type, stages] of Object.entries(stageDefaults)) {
      for (const [stage, role, sequence, max_days] of stages) {
        await StageConfig.updateOne(
          { application_type: type, stage },
          { $set: { sequence, role_responsible: role, max_days, requires_reason_on_delay: true, enabled: true, basis: "SYNTHETIC" } },
          { upsert: true, runValidators: true },
        );
      }
    }

    for (const [offset, index] of [[60, 0], [30, 1], [10, 2], [1, 3], [-5, 4]]) {
        const leaseApplication = applications[index];
        const document = await Document.findOneAndUpdate(
          { application_id: leaseApplication._id, original_name: `seed-lease-${index + 1}.pdf` },
          { $set: {
            uploaded_by: userByRole.get("INSTITUTION")._id,
            file_path: `seed/lease-${index + 1}.pdf`,
            file_hash: `demo-seed-lease-${index + 1}`,
            mime: "application/pdf",
            pages: 4,
            doc_type_slot: "Lease Deed",
            doc_type_final: "Lease Deed",
            status: "CONFIRMED",
            version: 1,
          } },
          { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
        );
        await LeaseDetail.findOneAndUpdate(
          { document_id: document._id },
        { $set: {
          lease_start: daysFromToday(-365 * 10),
          lease_end: daysFromToday(offset),
          lease_term_years: 10,
          registered: true,
          validity_status: offset < 0 ? "EXPIRED" : offset <= 60 ? "EXPIRING" : "VALID",
          next_alert_at: daysFromToday(offset - 60),
        } },
        { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
      );
    }

    await Student.findOneAndUpdate(
      { institution_id: institutions[0]._id, enrollment_no: "DEMO-CSE-001" },
      { $set: { name: "Aarav Demo", email: "student@approvaltrack.demo", phone: "+919900000008", programme: "B.Tech", branch: "Computer Science and Engineering", year: 3, status: "ACTIVE", deleted_at: null } },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
    );
    await Faculty.findOneAndUpdate(
      { institution_id: institutions[0]._id, employee_id: "DEMO-FAC-001" },
      { $set: { name: "Dr. Meera Demo", email: "faculty@approvaltrack.demo", phone: "+919900000009", designation: "Associate Professor", qualification: "Ph.D.", department: "Computer Science and Engineering", date_of_joining: daysFromToday(-365 * 6), status: "ACTIVE", deleted_at: null } },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
    );

    logger.info({ institutionCount: institutions.length, userCount: users.length, applicationCount: applications.length, policyVersion: "v2026.2", leaseSamples: 5 }, "Demo seed complete");
    return { institutions, users, applications };
  } finally {
    await disconnectDatabase();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  seedDatabase().catch((error) => {
    logger.error({ err: error }, "Demo seed failed");
    process.exitCode = 1;
  });
}
