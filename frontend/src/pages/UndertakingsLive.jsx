import { ClipboardCheck, Clock3, FileCheck2, TriangleAlert } from "lucide-react";
import { Badge, Card, DataTable, StatCard } from "../components/ui/primitives";

function daysUntil(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : Math.ceil((date.getTime() - Date.now()) / 86400000);
}

function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not available" : date.toLocaleDateString();
}

export default function UndertakingsLive({ data }) {
  const items = data.undertakings;
  const open = items.filter((item) => item.status !== "SUBMITTED");
  const dueSoon = open.filter((item) => {
    const remaining = daysUntil(item.dueDate);
    return remaining !== null && remaining >= 0 && remaining <= 7;
  });
  const overdue = items.filter((item) => item.status === "OVERDUE" || daysUntil(item.dueDate) < 0);
  const submitted = items.filter((item) => item.status === "SUBMITTED");
  const columns = [
    { accessorKey: "title", header: "Undertaking" },
    { accessorKey: "caseId", header: "Application reference" },
    { accessorKey: "dueDate", header: "Due date", cell: ({ getValue }) => dateLabel(getValue()) },
    { accessorKey: "status", header: "Status", cell: ({ getValue }) => <Badge variant={getValue() === "SUBMITTED" ? "success" : getValue() === "OVERDUE" ? "danger" : "warning"}>{getValue()}</Badge> },
  ];

  return <>
    <div className="stat-grid">
      <StatCard label="Open" value={open.length} icon={ClipboardCheck} />
      <StatCard label="Due within 7 days" value={dueSoon.length} icon={Clock3} />
      <StatCard label="Overdue" value={overdue.length} icon={TriangleAlert} />
      <StatCard label="Submitted" value={submitted.length} icon={FileCheck2} />
    </div>
    <Card title="Undertaking register" description="Records and statuses are retrieved from the backend.">
      <DataTable data={items} columns={columns} emptyText="No undertakings are available in your scope." />
    </Card>
  </>;
}
