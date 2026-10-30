import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "./db.js";
import { Policy, User } from "./index.js";
import { APPLICATION_TYPES, CHECKLIST_SLOTS } from "../engine/checklist.js";
import { buildCaseRoute } from "../engine/routes.js";
import { DEFAULT_ALERT_RULES, DEFAULT_PIPELINE_SETTINGS, DEFAULT_SCORE_WEIGHTS, DEFAULT_STAGE_COMPLETION } from "../engine/policyDefaults.js";
import { logger } from "../config/logger.js";

export async function seedWorkflowPolicies() {
  await connectDatabase();
  try {
    const admin = await User.findOne({ role: "ADMIN", status: "ACTIVE", deleted_at: null }).select("_id").lean();
    if (!admin) throw new Error("An active administrator account is required before workflow policy seeding");
    const routes = Object.fromEntries(APPLICATION_TYPES.map((type) => [type, buildCaseRoute(type)]));
    const defaults = {
      routes,
      checklist: CHECKLIST_SLOTS,
      stageCompletion: DEFAULT_STAGE_COMPLETION,
      alertRules: DEFAULT_ALERT_RULES,
      scoreWeights: DEFAULT_SCORE_WEIGHTS,
      blockSubmitOnMissing: false,
      pipelineSettings: DEFAULT_PIPELINE_SETTINGS,
      notes: "Seed configuration; checklist matrix, route choices, time windows and score weights are assumptions to verify against the final handbook.",
    };
    const versions = [
      { version: "v2026.1", status: "retired", signedOffAt: new Date("2026-09-01T00:00:00.000Z"), signedOffBy: admin._id },
      { version: "v2026.2", status: "signed_off", signedOffAt: new Date("2026-10-26T00:00:00.000Z"), signedOffBy: admin._id },
      { version: "v2026.3", status: "draft", signedOffAt: null, signedOffBy: null },
    ];
    for (const version of versions) {
      await Policy.updateOne(
        { version: version.version },
        { $setOnInsert: { ...defaults, ...version } },
        { upsert: true, runValidators: true },
      );
    }
    return versions.map(({ version }) => version);
  } finally {
    await disconnectDatabase();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  seedWorkflowPolicies()
    .then((versions) => logger.info({ versions }, "Workflow policy seed completed without changing accounts"))
    .catch((error) => {
      logger.error({ err: error }, "Workflow policy seed failed");
      process.exitCode = 1;
    });
}
