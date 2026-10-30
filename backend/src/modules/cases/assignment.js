import { CaseRecord, User } from "../../models/index.js";
import { chooseLeastLoadedOfficer } from "../../engine/queue.js";

export function stageRole(stage) {
  if (["scrutiny", "re_scrutiny", "regional_committee"].includes(stage)) return { role: "SCRUTINY_OFFICER", holderType: "officer" };
  if (stage === "evc") return { role: "EVC", holderType: "committee" };
  if (["shc", "sac"].includes(stage)) return { role: "SAC_SHC", holderType: "committee" };
  if (stage === "decision") return { role: "ADMIN", holderType: "officer" };
  return { role: null, holderType: "institution" };
}

export async function assignedHolder(stage, region, mode = "least_open_cases") {
  const assignment = stageRole(stage);
  if (!assignment.role) return { holderType: assignment.holderType, holderId: null };
  if (mode === "unassigned") return { holderType: assignment.holderType, holderId: null };
  const query = {
    role: assignment.role,
    status: "ACTIVE",
    deleted_at: null,
    ...(region && assignment.role !== "ADMIN" ? { region } : {}),
  };
  if (stage === "scrutiny") {
    const candidates = await User.find(query).select("_id").sort({ _id: 1 }).lean();
    if (!candidates.length) return { holderType: assignment.holderType, holderId: null };
    const loads = await CaseRecord.aggregate([
      {
        $match: {
          holderType: "officer",
          holderId: { $in: candidates.map((candidate) => candidate._id) },
          status: { $in: ["submitted", "in_progress"] },
          deletedAt: null,
        },
      },
      { $group: { _id: "$holderId", openCases: { $sum: 1 } } },
    ]);
    const loadByOfficer = new Map(loads.map((load) => [String(load._id), load.openCases]));
    const selected = chooseLeastLoadedOfficer(candidates, loadByOfficer);
    return { holderType: assignment.holderType, holderId: selected?._id || null };
  }
  const user = await User.findOne(query).select("_id").lean();
  return { holderType: assignment.holderType, holderId: user?._id || null };
}
