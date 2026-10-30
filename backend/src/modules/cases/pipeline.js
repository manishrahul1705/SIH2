import { CaseRecord, Policy } from "../../models/index.js";
import { evaluateCase } from "../../engine/evaluateCase.js";
import { logger } from "../../config/logger.js";
import { buildCaseFacts } from "./facts.js";
import { applyPlan } from "./applyPlan.js";
import { env } from "../../config/env.js";
import { enqueueQueuedJob } from "../jobs/queue.js";
import { randomUUID } from "node:crypto";

const PIPELINE_INTENTS = new Set(["CHANGE", "SUBMIT", "RESUBMIT", "STAGE_COMPLETE", "EVC_REPORT"]);

export async function evaluateCasePipeline({
  caseId,
  intent = "CHANGE",
  completedChecklist = [],
  expectedVersion,
  apply = false,
  actorId = null,
  now = new Date(),
}) {
  if (!PIPELINE_INTENTS.has(intent)) {
    throw Object.assign(new Error("Unsupported pipeline evaluation intent"), { code: "INVALID_PIPELINE_INTENT" });
  }
  const record = await CaseRecord.findOne({ _id: caseId, deletedAt: null });
  if (!record) throw Object.assign(new Error("Case not found"), { code: "CASE_NOT_FOUND" });
  if (Number.isInteger(expectedVersion) && record.version !== expectedVersion) {
    throw Object.assign(new Error("Case changed; reload and retry evaluation"), { code: "CASE_VERSION_CONFLICT" });
  }
  const policy = await Policy.findOne({ version: record.policyVersion }).lean();
  if (!policy) throw Object.assign(new Error("The case policy version is unavailable"), { code: "POLICY_UNAVAILABLE" });
  const facts = await buildCaseFacts(record, policy, intent);
  if (intent === "STAGE_COMPLETE") facts.completedChecklist = completedChecklist;
  const plan = evaluateCase(facts, policy, now);
  const applied = apply && !record.workflowVersion
    ? await applyPlan({ caseId: record._id, plan, expectedVersion: record.version, intent, actorId, now })
    : null;
  return {
    facts,
    findings: plan.findings,
    actions: plan.actions,
    explain: plan.explain,
    planHash: plan.planHash,
    applied: applied ? applied.applied : false,
    held: applied ? applied.held : plan.actions.some((action) => action.type === "HOLD"),
    case: applied?.case || record,
  };
}

export function scheduleCaseEvaluation(options) {
  if (env.QUEUE_MODE === "bullmq") {
    enqueueQueuedJob("case-evaluation", {
      type: "case-evaluation",
      caseId: String(options.caseId),
      intent: options.intent || "CHANGE",
      actorId: options.actorId ? String(options.actorId) : null,
    }, {
      jobId: `case-${String(options.caseId)}-${randomUUID()}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: { age: 3600, count: 5000 },
      removeOnFail: { age: 604800, count: 5000 },
    }).catch((error) => {
      logger.error({ caseId: String(options.caseId), code: error.code || "CASE_QUEUE_FAILED" }, "Could not enqueue case evaluation");
    });
    return;
  }
  setImmediate(() => {
    evaluateCasePipeline({ ...options, apply: true }).catch((error) => {
      logger.error({
        caseId: String(options.caseId),
        code: error.code || "PIPELINE_EVALUATION_FAILED",
      }, "Case pipeline evaluation failed");
    });
  });
}
