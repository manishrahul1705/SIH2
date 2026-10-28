import { BarChart3, Building2, Users } from "lucide-react";
import { Badge, Card, DataTable, StatCard } from "../components/ui/primitives";

function monthLabel(value) {
  const month = Number(value.month);
  const date = new Date(Number(value.year), month - 1, 1);
  return Number.isNaN(date.getTime()) ? `${value.year}-${value.month}` : date.toLocaleString(undefined, { month: "short", year: "numeric" });
}

export default function ReportsLive({ data }) {
  const analytics = data.analytics;
  const monthlyRows = (analytics?.applicationVolume || []).map((item) => ({
    month: monthLabel(item._id),
    applications: item.count,
  }));
  const columns = [
    { accessorKey: "month", header: "Month" },
    { accessorKey: "applications", header: "Applications" },
  ];

  if (!analytics) {
    return <Card title="Reports"><p className="muted">Analytics are not available for this account.</p></Card>;
  }

  return <>
    <div className="stat-grid">
      <StatCard label="Institutions" value={analytics.institutions} icon={Building2} />
      <StatCard label="Active students" value={analytics.activeStudents} icon={Users} />
      <StatCard label="Active faculty" value={analytics.activeFaculty} icon={Users} />
      <StatCard label="Application periods" value={monthlyRows.length} icon={BarChart3} />
    </div>
    <Card title="Application volume" description="Monthly counts returned by the analytics endpoint.">
      <DataTable data={monthlyRows} columns={columns} emptyText="No application volume has been recorded for the current period." />
    </Card>
    <Card title="Report exports"><Badge variant="neutral">No saved report exports</Badge><p className="muted">This backend currently provides analytics data but does not store generated report files.</p></Card>
  </>;
}
