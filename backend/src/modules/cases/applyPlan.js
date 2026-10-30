// Applies deterministic intake pipeline plans transactionally, per specification sections 10 and 15.
import crypto from "node:crypto";
import {
  CaseFinding,
  CaseObligation,
  CaseRecord,
  CaseStageHistory,
  CaseTask,
  OutboxEvent,
  Policy,
} from "../../models/index.js";
import { assignedHolder } from "./assignment.js";
import { withTransaction, writeAudit } from "../../middleware/audit.js";

function outboxEvent(session, type, record, payload) {
  return OutboxEvent.create([{
    eventId: crypto.randomUUID(),
    eventType: type,
    entityId: record._id.toString(),
    payload: { caseNo: record.caseNo, currentStage: record.currentStage, ...payload },
  }], session ? { session } : {});
}

async function recordStageTransition(session, record, previousStage, actorId, reason) {
  let openQuery = CaseStageHistory.findOne({ caseId: record._id, leftAt: null }).sort({ enteredAt: -1 });
  if (session) openQuery = openQuery.session(session);
  const openStage = await openQuery;
  if (openStage) {
    openStage.leftAt = record.stageEnteredAt;
    await openStage.save(session ? { session } : {});
  }
  await CaseStageHistory.create([{
    caseId: record._id,
    fromStage: previousStage,
    toStage: record.currentStage,
    holderType: record.holderType,
    holderId: record.holderId,
    actorId,
    enteredAt: record.stageEnteredAt,
    reason,
  }], session ? { session } : {});
}

function taskSelector(record, action) {
  if (action.task === "EVC") return { caseId: record._id, type: "EVC" };
  if (action.task === "VERIFY_DOCUMENT") return { documentId: action.payload?.documentId, type: "VERIFY_DOCUMENT" };
  if (action.task === "REVIEW") return { caseId: record._id, slotId: action.payload?.slotId, type: "REVIEW" };
  if (action.task === "DEFICIENCY_RESPONSE") return { caseId: record._id, documentId: action.payload?.documentId, type: "DEFICIENCY_RESPONSE" };
  return { caseId: record._id, type: action.task };
}

async function createTask(session, record, action) {
  const taskType = action.task;
  const currentHolder = {
    holderType: taskType === "EVC" ? "committee" : taskType === "DEFICIENCY_RESPONSE" ? "institution" : "officer",
    holderId: taskType === "DEFICIENCY_RESPONSE" ? null : record.holderId,
  };
  const selector = taskSelector(record, action);
  await CaseTask.findOneAndUpdate(
    selector,
    {
      $setOnInsert: {
        ...selector,
        caseId: record._id,
        documentId: action.payload?.documentId || null,
        slotId: action.payload?.slotId || "",
        type: taskType,
        holderType: currentHolder.holderType,
        holderId: currentHolder.holderId,
        state: taskType === "EVC" ? "queued" : "open",
        createdByRule: taskType === "EVC" ? "SA-06" : taskType === "VERIFY_DOCUMENT" ? "SA-12" : taskType === "REVIEW" ? "DR-02" : "SA-10",
        payload: action.payload || {},
      },
    },
    { upsert: true, new: true, runValidators: true, ...(session ? { session } : {}) },
  );
}

async function applyAction(session, record, action, actorId, now, intent, assignmentMode) {
  switch (action.type) {
    case "SET_ROUTE":
      record.route = action.route;
      return "case.route_updated";
    case "MOVE_STAGE": {
      const previousStage = record.currentStage;
      if (previousStage === action.to) return null;
      record.currentStage = action.to;
      if (intent === "SUBMIT") {
        record.status = "submitted";
        record.submittedAt = now;
        record.completedStages = [...new Set([...record.completedStages, "submitted", "self_disclosure"])];
      } else {
        record.completedStages = [...new Set([...record.completedStages, previousStage])];
        record.status = "in_progress";
      }
      record.stageEnteredAt = now;
      await recordStageTransition(session, record, previousStage, actorId, action.reason);
      if (intent === "SUBMIT") return "case.submitted";
      return action.auto ? "case.stage_moved" : "case.stage_advanced";
    }
    case "RESUBMIT_CASE": {
      const previousStage = record.currentStage;
      record.status = "in_progress";
      record.returnedToStage = "";
      record.returnReason = "";
      record.stageEnteredAt = now;
      await recordStageTransition(session, record, previousStage, actorId, action.reason);
      return "case.resubmitted";
    }
    case "ASSIGN_HOLDER": {
      const assignment = await assignedHolder(action.stage || record.currentStage, record.region, assignmentMode);
      record.holderType = assignment.holderType;
      record.holderId = assignment.holderId;
      return "case.holder_assigned";
    }
    case "CREATE_TASK":
      await createTask(session, record, action);
      return "case.task_created";
    case "COMPLETE_TASK":
      await CaseTask.updateOne(
        { _id: action.taskId, caseId: record._id, state: { $in: ["open", "queued"] } },
        { $set: { state: "completed", completedAt: now } },
        session ? { session } : {},
      );
      return "case.task_completed";
    case "CREATE_OBLIGATION":
      await CaseObligation.create([{
        caseId: record._id,
        institutionId: record.institutionId,
        ownerType: "institution",
        ...action.payload,
      }], session ? { session } : {});
      return "case.obligation_created";
    case "CLOSE_OBLIGATION":
      await CaseObligation.updateOne(
        { _id: action.obligationId, caseId: record._id, closure: "open" },
        { $set: { closure: "closed" } },
        session ? { session } : {},
      );
      return "case.obligation_closed";
    case "RAISE_FINDING": {
      const finding = action.finding;
      const selector = {
        caseId: record._id,
        code: finding.code,
        documentId: finding.evidence?.documentId || null,
        slotId: finding.evidence?.slotId || "",
        status: "open",
      };
      await CaseFinding.findOneAndUpdate(selector, {
        $setOnInsert: {
          ...selector,
          ruleId: finding.ruleId,
          severity: finding.severity,
          scope: finding.evidence?.documentId ? "document" : finding.scope,
          message: finding.message,
          evidence: finding.evidence || {},
          suggestedAction: finding.suggestedAction || "",
          advisory: finding.advisory === true,
          createdBy: "pipeline",
        },
      }, { upsert: true, new: true, runValidators: true, ...(session ? { session } : {}) });
      return "case.finding_raised";
    }
    case "RESOLVE_FINDING":
      await CaseFinding.updateMany(
        { caseId: record._id, code: action.code, status: "open", ...(action.documentId ? { documentId: action.documentId } : {}), ...(action.slotId ? { slotId: action.slotId } : {}) },
        { $set: { status: "resolved", resolvedAt: now } },
        session ? { session } : {},
      );
      return "case.finding_resolved";
    case "SET_PRELIMINARY":
      record.preliminary = action.state;
      return "case.preliminary_updated";
    case "NOTIFY":
      return "case.notification_requested";
    case "RECOMMEND_RETURN":
    case "HOLD":
      return null;
    default:
      throw Object.assign(new Error(`Unsupported case plan action: ${action.type}`), { code: "UNSUPPORTED_PLAN_ACTION" });
  }
}

export async function applyPlan({ caseId, plan, expectedVersion, intent, actorId = null, now = new Date() }) {
  return withTransaction(async (session) => {
    let query = CaseRecord.findOne({ _id: caseId, deletedAt: null });
    if (session) query = query.session(session);
    const record = await query;
    if (!record) throw Object.assign(new Error("Case not found"), { code: "CASE_NOT_FOUND" });
    if (record.version !== expectedVersion) throw Object.assign(new Error("Case changed; reload and retry evaluation"), { code: "CASE_VERSION_CONFLICT" });
    if (record.lastPlanIntent === intent && record.lastPlanHash === plan.planHash) {
      return { case: record, applied: false, held: plan.actions.some((action) => action.type === "HOLD"), planHash: plan.planHash };
    }
    let policyQuery = Policy.findOne({ version: record.policyVersion }).select("pipelineSettings");
    if (session) policyQuery = policyQuery.session(session);
    const policy = await policyQuery.lean();
    if (!policy) throw Object.assign(new Error("The case policy version is unavailable"), { code: "POLICY_UNAVAILABLE" });
    const assignmentMode = policy.pipelineSettings?.holderAssignment || "least_open_cases";
    const held = plan.actions.some((action) => action.type === "HOLD");

    for (const action of plan.actions) {
      if (held && !["RAISE_FINDING", "RESOLVE_FINDING", "SET_PRELIMINARY", "HOLD"].includes(action.type)) continue;
      const eventType = await applyAction(session, record, action, actorId, now, intent, assignmentMode);
      await writeAudit({
        actor_id: actorId,
        action: "PIPELINE_PLAN_ACTION_APPLIED",
        entity: "CaseRecord",
        entity_id: record._id,
        after_json: { ruleId: action.ruleId || action.type, actionType: action.type, planHash: plan.planHash, intent },
      }, { session });
      if (eventType) {
        await outboxEvent(session, eventType, record, {
          planHash: plan.planHash,
          actionType: action.type,
          ...(action.type === "NOTIFY" ? { recipient: action.to, template: action.template } : {}),
        });
      }
    }
    record.lastPlanHash = plan.planHash;
    record.lastPlanIntent = intent;
    record.lastEvaluatedAt = now;
    record.version += 1;
    await record.save(session ? { session } : {});
    await outboxEvent(session, "case.updated", record, { planHash: plan.planHash, intent });
    return { case: record, applied: true, held, planHash: plan.planHash };
  });
}
