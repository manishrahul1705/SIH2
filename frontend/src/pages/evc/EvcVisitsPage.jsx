import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarClock, CalendarDays, CheckCircle2, Clock3, FileCheck2, MapPin, RefreshCw, ShieldCheck } from "lucide-react";
import { Badge, Card, StatCard } from "../../components/ui/primitives";
import { evcApi } from "../../services/evc";

const filters = [
  { id: "all", label: "All visits" },
  { id: "upcoming", label: "Scheduled" },
  { id: "report_due", label: "Report pending" },
  { id: "reported", label: "Report submitted" },
  { id: "approved", label: "Approved" },
];

function visitDate(value, options = { dateStyle: "medium", timeStyle: "short" }) {
  if (!value) return "Date not set";
  const dateOnly = /^(\d{4}-\d{2}-\d{2})(?:T00:00(?::00(?:\.000)?)?Z)?$/.exec(String(value));
  const date = new Date(dateOnly ? `${dateOnly[1]}T12:00:00` : value);
  return Number.isNaN(date.getTime()) ? "Date not set" : date.toLocaleString(undefined, options);
}

function localDateKey(value = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function scheduledDateKey(value) {
  return String(value || "").slice(0, 10);
}

function upcomingWindowEnd() {
  const today = new Date();
  today.setDate(today.getDate() + 7);
  return localDateKey(today);
}

function visitState(item) {
  if (item.inspectionStatus === "APPROVED") return { id: "approved", label: "EVC approval complete", variant: "success" };
  if (item.inspectionStatus === "REPORT_UPLOADED") return { id: "reported", label: "Inspection report submitted", variant: "info" };
  if (item.inspectionStatus === "SCHEDULED" && item.scheduled_inspection_date
    && scheduledDateKey(item.scheduled_inspection_date) < localDateKey()) {
    return { id: "report_due", label: "Inspection date passed · report pending", variant: "warning" };
  }
  if (item.inspectionStatus === "SCHEDULED") return { id: "upcoming", label: "Scheduled", variant: "info" };
  return null;
}

function VisitCard({ visit }) {
  const state = visitState(visit);
  const detailTab = visit.inspectionStatus === "REPORT_UPLOADED" ? "waiting_approval" : "waiting_inspection";
  return <article className="evc-visit-card">
    <div className="evc-visit-card-top">
      <div className="evc-visit-date"><CalendarDays size={17} /><span>{visitDate(visit.scheduled_inspection_date)}</span></div>
      <Badge variant={state.variant}>{state.label}</Badge>
    </div>
    <div>
      <h3>{visit.institution}</h3>
      <p className="evc-visit-case">{visit.caseNo} · {visit.applicationType?.replaceAll("_", " ")}</p>
    </div>
    <div className="evc-visit-meta">
      <span><MapPin size={14} />{visit.region || "Region not set"}</span>
      <span><Clock3 size={14} />{visit.inspection_mode || "Inspection mode not set"}</span>
      <span><ShieldCheck size={14} />{visit.stageName || "EVC inspection"}</span>
    </div>
    {visit.stageDueAt && <p className="evc-visit-sla">EVC stage SLA due {visitDate(visit.stageDueAt, { dateStyle: "medium" })}</p>}
    {visit.inspectionStatus === "APPROVED"
      ? <Badge variant="success">Completed</Badge>
      : <Link className="button button-secondary button-small" to={`/cases/${visit._id}?tab=${detailTab}`}>
        {visit.inspectionStatus === "REPORT_UPLOADED" ? "Review report" : "Open visit"}
      </Link>}
  </article>;
}

function VisitFilters({ active, counts, onSelect }) {
  return <div className="evc-visit-filters" role="tablist" aria-label="Filter EVC visits">
    {filters.map((filter) => <button
      className={`evc-visit-filter ${active === filter.id ? "active" : ""}`}
      type="button"
      role="tab"
      aria-selected={active === filter.id}
      key={filter.id}
      onClick={() => onSelect(filter.id)}
    >{filter.label}<span>{counts[filter.id]}</span></button>)}
  </div>;
}

export default function EvcVisitsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [activeFilter, setActiveFilter] = useState("all");
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async () => {
    setError("");
    try {
      setData(await evcApi.getDashboard());
      setNow(new Date());
    } catch (loadError) {
      setError(loadError.message || "Could not load assigned EVC visits.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = setInterval(() => { void load(); }, 60000);
    return () => clearInterval(timer);
  }, [load]);

  const visits = useMemo(() => {
    if (!data) return [];
    return [
      ...(data.inspection || []).filter((item) => item.inspectionStatus === "SCHEDULED"),
      ...(data.approval || []),
      ...(data.completed || []),
    ].map((item) => ({ ...item, visitState: visitState(item) }))
      .filter((item) => item.visitState)
      .sort((a, b) => new Date(a.scheduled_inspection_date || a.approvedAt || 0) - new Date(b.scheduled_inspection_date || b.approvedAt || 0));
  }, [data, now]);

  const nextSevenDays = useMemo(() => {
    const today = localDateKey();
    const end = upcomingWindowEnd();
    return visits.filter((item) => item.visitState.id === "upcoming"
      && scheduledDateKey(item.scheduled_inspection_date) >= today
      && scheduledDateKey(item.scheduled_inspection_date) < end);
  }, [visits]);
  const counts = useMemo(() => ({
    all: visits.length,
    upcoming: visits.filter((item) => item.visitState.id === "upcoming").length,
    report_due: visits.filter((item) => item.visitState.id === "report_due").length,
    reported: visits.filter((item) => item.visitState.id === "reported").length,
    approved: visits.filter((item) => item.visitState.id === "approved").length,
  }), [visits]);
  const filteredVisits = activeFilter === "all" ? visits : visits.filter((item) => item.visitState.id === activeFilter);
  const nextVisit = visits.find((item) => item.visitState.id === "upcoming"
    && scheduledDateKey(item.scheduled_inspection_date) >= localDateKey());

  return <main className="evc-workspace">
    <header className="evc-workspace-heading">
      <div><p className="eyebrow">EXPERT VISIT COMMITTEE</p><h1>My Visits</h1><p>Your inspection schedule, report follow-ups, and visit outcomes.</p></div>
      <button className="button button-secondary button-small" type="button" onClick={() => void load()}><RefreshCw size={15} /> Refresh</button>
    </header>

    {error && <div className="evc-state evc-error" role="alert"><span>{error}</span><button className="button button-secondary button-small" type="button" onClick={() => void load()}>Retry</button></div>}

    <div className="stat-grid">
      <StatCard label="Upcoming visits" value={counts.upcoming} note="Scheduled from today onward" icon={CalendarClock} />
      <StatCard label="Next 7 days" value={nextSevenDays.length} note="Visits requiring preparation" icon={CalendarDays} variant="warning" />
      <StatCard label="Report follow-up" value={counts.report_due} note="Inspection date passed; report not uploaded" icon={FileCheck2} variant="warning" />
      <StatCard label="Reports submitted" value={counts.reported} note="Awaiting committee approval" icon={CheckCircle2} variant="info" />
    </div>

    <div className="evc-visits-overview">
      <Card title="Next assigned inspection" description="Your nearest scheduled campus or virtual inspection.">
        {nextVisit
          ? <div className="evc-next-visit">
            <div className="evc-next-visit-date">{visitDate(nextVisit.scheduled_inspection_date, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</div>
            <strong>{nextVisit.institution}</strong>
            <span>{nextVisit.caseNo} · {nextVisit.applicationType?.replaceAll("_", " ")}</span>
            <span>{nextVisit.inspection_mode || "Inspection mode not set"} · {nextVisit.region || "Region not set"}</span>
            <Link className="button button-primary button-small" to={`/cases/${nextVisit._id}?tab=waiting_inspection`}>Open inspection details</Link>
          </div>
          : <p className="muted">No future inspection is currently scheduled.</p>}
      </Card>
      <Card title="Visit preparation" description="A focused checklist for your next assigned inspection.">
        <ul className="evc-preparation-list">
          <li><CheckCircle2 size={16} /><span>Review submitted institution documents and extracted fields.</span></li>
          <li><CheckCircle2 size={16} /><span>Confirm panel members, visit mode, and focus areas.</span></li>
          <li><CheckCircle2 size={16} /><span>Record inspection findings and upload the signed report after the visit.</span></li>
        </ul>
        {counts.report_due > 0 && <p className="evc-visit-reminder"><Clock3 size={15} /> {counts.report_due} scheduled date(s) have passed; upload reports or open the visit to update its status.</p>}
      </Card>
    </div>

    <Card title="Visit schedule and outcomes" description="Only assigned EVC inspections are shown. A passed date is flagged for follow-up; it does not mark the inspection completed automatically.">
      <VisitFilters active={activeFilter} counts={counts} onSelect={setActiveFilter} />
      {!data && !error
        ? <div className="loading-state" aria-label="Loading visits"><i /><i /><i /></div>
        : filteredVisits.length
          ? <div className="evc-visit-grid">{filteredVisits.map((visit) => <VisitCard key={visit._id} visit={visit} />)}</div>
          : <div className="evc-empty"><CalendarDays size={25} /><strong>No visits in this category.</strong><span>Scheduled EVC inspections and their report outcomes will appear here.</span></div>}
    </Card>
  </main>;
}
