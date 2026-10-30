import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, ClipboardCheck, Clock3, FileText } from "lucide-react";
import { PageHeader } from "../components/stakeholder/PortalPrimitives";
import { Badge, Card, DataTable, StatCard } from "../components/ui/primitives";
import { caseWorkflowApi } from "../services/caseWorkflow";

function daysUntil(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.ceil((date.getTime() - Date.now()) / 86400000);
}

function formatDate(value) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not available" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function assistStatusName(item) {
  const status = item?.assist?.status || item?.assist?.decisionStatus || "PENDING";
  if (["DECIDED", "APPROVED", "REJECTED", "RESOLVED", "CLOSED"].includes(status)) return "Completed";
  if (status === "OVERDUE") return "Overdue";
  return "Pending review";
}

export default function AssistRequestsPage() {
  const [requests, setRequests] = useState([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    caseWorkflowApi.getMyAssistRequests()
      .then((items) => { if (active) setRequests(items); })
      .catch((loadError) => { if (active) setError(loadError.message || "Assist requests could not be loaded."); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);

  const rows = useMemo(() => requests.map((item) => ({
    id: item.assist?._id || item.caseId,
    caseId: item.caseId,
    caseNo: item.caseNo,
    applicationType: item.applicationType?.replaceAll("_", " ") || "General",
    stageName: item.stageName || "Stage review",
    dueDate: item.assist?.assistDueAt || item.assist?.dueAt,
    note: item.assist?.note || "No additional note provided.",
    status: assistStatusName(item),
  })), [requests]);

  const pending = rows.filter((row) => row.status === "Pending review");
  const dueSoon = rows.filter((row) => {
    const remaining = daysUntil(row.dueDate);
    return remaining !== null && remaining >= 0 && remaining <= 7 && row.status === "Pending review";
  });
  const overdue = rows.filter((row) => {
    const remaining = daysUntil(row.dueDate);
    return remaining !== null && remaining < 0 && row.status === "Pending review";
  });
  const completed = rows.filter((row) => row.status === "Completed");

  const columns = [
    { accessorKey: "caseNo", header: "Application", cell: ({ row }) => <Link className="text-link" to={`/case/${row.original.caseId}`}>{row.original.caseNo}</Link> },
    { accessorKey: "applicationType", header: "Application type" },
    { accessorKey: "stageName", header: "Stage" },
    { accessorKey: "dueDate", header: "Due date", cell: ({ getValue }) => formatDate(getValue()) },
    { accessorKey: "status", header: "Status", cell: ({ getValue }) => <Badge variant={getValue() === "Completed" ? "success" : getValue() === "Overdue" ? "danger" : "warning"}>{getValue()}</Badge> },
  ];

  return <section className="page-container">
    <PageHeader
      eyebrow="ASSIGNED REVIEW TASKS"
      title="Stage assist requests"
      description="Review the saved application documents and field confirmations before responding."
    />

    {error && <p className="alert alert-warning" role="alert">{error}</p>}
    {busy && <p className="muted" role="status">Loading assigned requests…</p>}

    {!busy && !error && requests.length > 0 && <>
      <div className="stat-grid">
        <StatCard label="Open" value={pending.length} note="Awaiting response" icon={ClipboardCheck} />
        <StatCard label="Due within 7 days" value={dueSoon.length} note="Needs attention soon" icon={Clock3} />
        <StatCard label="Overdue" value={overdue.length} note="Past the requested date" icon={AlertTriangle} />
        <StatCard label="Completed" value={completed.length} note="Resolved requests" icon={CheckCircle2} />
      </div>

      <Card title="Assist request register" description="Review case-specific assistance requests raised during stage processing.">
        <DataTable data={rows} columns={columns} emptyText="No assist requests are available in your scope." />
      </Card>
    </>}

    {!busy && !error && !requests.length && <div className="state-card"><FileText size={27} /><h3>No pending assist requests</h3><p>Requests assigned to your account will appear here.</p></div>}
  </section>;
}
