import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Badge, Card, DataTable } from "../components/ui/primitives";
import { useAppStore } from "../store/useAppStore";
import { caseWorkflowApi } from "../services/caseWorkflow";

const ACTIVE_FINAL_STATUSES = new Set(["ACTIVE", "ACTIVE_UNFROZEN", "FROZEN_WAITING_FOR_ASSIST"]);
const applicationTypeLabels = {
  new_institution: "New institution",
  new_course: "New course",
  increase_in_intake: "Increase in intake",
  extension_of_approval: "Extension of approval",
  conversion_diploma_to_degree: "Conversion of diploma to degree",
  collaboration_twinning: "Collaboration or twinning programme",
  restoration_of_intake: "Restoration of intake",
};

function isAssignedToBureauOfficer(stage, user) {
  const assignedUserId = stage?.assignedUserId;
  const userId = user?.id || user?._id;
  return !assignedUserId || String(assignedUserId) === String(userId);
}

function approvalRows(records, user) {
  return records.flatMap((record) => {
    const stage = record.allocatedStages?.[record.currentStageIndex];
    if (
      !stage
      || stage.key !== "final_approval"
      || !ACTIVE_FINAL_STATUSES.has(stage.status)
      || stage.assignedRole !== "BUREAU_OFFICER"
      || !isAssignedToBureauOfficer(stage, user)
    ) return [];

    return [{
      caseId: record._id,
      caseNo: record.caseNo,
      institution: record.institutionId?.name || "Institution",
      applicationType: applicationTypeLabels[record.applicationType] || record.applicationType,
      stageStatus: stage.status,
      dueAt: stage.stageDueAt,
      updatedAt: record.updatedAt,
    }];
  });
}

export default function BureauApprovalQueuePage() {
  const user = useAppStore((state) => state.user);
  const [approvals, setApprovals] = useState(null);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    async function loadApprovals() {
      try {
        const records = [];
        for (let page = 1; ; page += 1) {
          const batch = await caseWorkflowApi.listCases({ page, pageSize: 100 });
          if (!Array.isArray(batch)) throw new Error("The approval queue returned an invalid response.");
          records.push(...batch);
          if (batch.length < 100) break;
        }
        if (active) setApprovals(approvalRows(records, user));
      } catch (loadError) {
        if (active) setError(loadError.message || "Could not load final approvals.");
      }
    }
    loadApprovals();
    return () => { active = false; };
  }, [reloadKey, user]);

  const columns = useMemo(() => [
    {
      accessorKey: "caseNo",
      header: "Application",
      cell: ({ row }) => <Link className="mono text-link" to={`/case/${row.original.caseId}`}>{row.original.caseNo}</Link>,
    },
    { accessorKey: "institution", header: "Institution" },
    { accessorKey: "applicationType", header: "Application type" },
    {
      accessorKey: "stageStatus",
      header: "Stage status",
      cell: ({ row }) => <Badge variant={row.original.stageStatus === "FROZEN_WAITING_FOR_ASSIST" ? "warning" : "info"}>
        {row.original.stageStatus === "FROZEN_WAITING_FOR_ASSIST" ? "Frozen for assistance" : "Awaiting final approval"}
      </Badge>,
    },
    {
      accessorKey: "dueAt",
      header: "Due date",
      cell: ({ getValue }) => getValue() ? new Date(getValue()).toLocaleDateString() : "Not set",
    },
  ], []);

  if (approvals === null) {
    return <Card title="Bureau Officer final approval queue">
      {error
        ? <div className="state-card state-error"><AlertTriangle size={22} /><p>{error}</p><button className="button button-secondary" onClick={() => { setError(""); setApprovals(null); setReloadKey((key) => key + 1); }}><RefreshCw size={15} /> Try again</button></div>
        : <div className="loading-state" aria-label="Loading final approvals"><i /><i /><i /></div>}
    </Card>;
  }

  return <Card
    title="Bureau Officer final approval queue"
    description="Applications appear here after all earlier allocated stages have been approved and the final stage is assigned to your Bureau Officer account."
  >
    <DataTable
      data={approvals}
      columns={columns}
      emptyText="No applications are currently awaiting Bureau Officer approval."
    />
  </Card>;
}
