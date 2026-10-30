import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Building2,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  FileCheck2,
  FileText,
  Filter,
  RotateCw,
  Scale,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { Badge } from "../components/ui/primitives";
import { caseWorkflowApi } from "../services/caseWorkflow";

const PAGE_SIZE = 5;

const applicationTypes = {
  new_institution: "New institution",
  new_course: "New course",
  increase_in_intake: "Increase in intake",
  extension_of_approval: "Extension of approval",
  conversion_diploma_to_degree: "Conversion of diploma to degree",
  collaboration_twinning: "Collaboration / twinning",
  restoration_of_intake: "Restoration of intake",
};

const stageNames = {
  submitted: "Submission",
  self_disclosure: "Self-disclosure",
  scrutiny: "Scrutiny",
  re_scrutiny: "Re-scrutiny",
  regional_committee: "Regional Committee",
  evc: "EVC",
  shc: "SHC",
  sac: "SAC",
  decision: "Bureau review",
};

const sampleRows = [
  {
    applicationId: "AT-2026-0142",
    institution: "Sri Venkateswara Institute of Technology",
    region: "Chennai, Tamil Nadu",
    applicationType: "New course",
    route: "Scrutiny → EVC → Bureau review",
    completedAt: "2026-10-28T10:45:00+05:30",
    status: "Awaiting decision",
    sample: true,
  },
  {
    applicationId: "AT-2026-0137",
    institution: "Greenfield College of Engineering",
    region: "Coimbatore, Tamil Nadu",
    applicationType: "Increase in intake",
    route: "Scrutiny → Bureau review",
    completedAt: "2026-10-27T16:20:00+05:30",
    status: "Awaiting decision",
    sample: true,
  },
  {
    applicationId: "AT-2026-0129",
    institution: "Kaveri Institute of Management",
    region: "Trichy, Tamil Nadu",
    applicationType: "Extension of approval",
    route: "Scrutiny → EVC → Bureau review",
    completedAt: "2026-10-26T11:15:00+05:30",
    status: "Awaiting decision",
    sample: true,
  },
];

function isReadyForDecision(record) {
  return record.currentStage === "decision"
    && record.status === "in_progress"
    && !record.workflowVersion
    && Array.isArray(record.route)
    && record.route.length > 0
    && record.completedStages?.length >= Math.max(0, record.route.length - 1);
}

function isAtDecisionStage(record) {
  return record.currentStage === "decision"
    && record.status === "in_progress"
    && !record.workflowVersion;
}

function routeFor(record) {
  return (record.route || []).map((stage) => stageNames[stage] || stage.replaceAll("_", " ")).join(" → ");
}

function completedAtFor(record) {
  const completedStage = [...(record.allocatedStages || [])]
    .reverse()
    .find((stage) => stage.key !== "decision" && stage.status === "APPROVED" && stage.approvedAt);
  return completedStage?.approvedAt || record.updatedAt || record.createdAt || null;
}

function toDecisionRow(record) {
  return {
    caseId: record._id,
    applicationId: record.caseNo || record._id,
    institution: record.institutionId?.name || "Institution name unavailable",
    region: record.region || "Region not recorded",
    applicationType: applicationTypes[record.applicationType] || record.applicationType?.replaceAll("_", " ") || "Application",
    route: routeFor(record),
    completedAt: completedAtFor(record),
    version: record.version,
    status: "Awaiting decision",
    sample: false,
  };
}

function dateLabel(value) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Not recorded"
    : date.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function exportCsv(rows) {
  const headers = ["Application ID", "Institution", "Region", "Application type", "Review route", "Completed", "Status"];
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [headers, ...rows.map((row) => [
    row.applicationId,
    row.institution,
    row.region,
    row.applicationType,
    row.route,
    dateLabel(row.completedAt),
    row.status,
  ])].map((line) => line.map(quote).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "approvaltrack-decisions-queue.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function MetricCard({ tone, icon: Icon, label, value, note }) {
  return <article className={`decision-metric decision-metric-${tone}`}>
    <span className="decision-metric-icon"><Icon size={22} /></span>
    <span className="decision-metric-copy">
      <small>{label}</small>
      <strong>{value}</strong>
      <span>{note}</span>
    </span>
    <ArrowRight className="decision-metric-arrow" size={18} />
  </article>;
}

export default function DecisionsLive({ setMessage }) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [routeFilter, setRouteFilter] = useState("all");
  const [dateOrder, setDateOrder] = useState("newest");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const [outcome, setOutcome] = useState("approved");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const loadCases = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const allRecords = [];
      for (let currentPage = 1; ; currentPage += 1) {
        const batch = await caseWorkflowApi.listCases({ page: currentPage, pageSize: 100 });
        if (!Array.isArray(batch)) throw new Error("The decision queue returned an invalid response.");
        allRecords.push(...batch);
        if (batch.length < 100) break;
      }
      setRecords(allRecords);
    } catch (loadError) {
      setError(loadError.message || "The decision queue could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCases();
  }, [loadCases]);

  const decisionStageCases = useMemo(() => records.filter(isAtDecisionStage), [records]);
  const eligibleCases = useMemo(() => decisionStageCases.filter(isReadyForDecision), [decisionStageCases]);
  const realRows = useMemo(() => eligibleCases.map(toDecisionRow), [eligibleCases]);
  const isDemo = !loading && !error && realRows.length === 0;
  const sourceRows = isDemo ? sampleRows : realRows;
  const routeOptions = useMemo(() => [...new Set(sourceRows.map((row) => row.route))], [sourceRows]);

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return sourceRows
      .filter((row) => !query || [row.institution, row.applicationId, row.applicationType].some((value) => value.toLowerCase().includes(query)))
      .filter((row) => routeFilter === "all" || row.route === routeFilter)
      .filter((row) => statusFilter === "all" || row.status === "Awaiting decision")
      .sort((left, right) => {
        const delta = new Date(left.completedAt).getTime() - new Date(right.completedAt).getTime();
        return dateOrder === "newest" ? -delta : delta;
      });
  }, [sourceRows, search, routeFilter, statusFilter, dateOrder]);

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const visibleRows = filteredRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const completedRouteCount = eligibleCases.length;
  const finalStageCount = decisionStageCases.length;
  const routePendingCount = Math.max(0, finalStageCount - completedRouteCount);

  useEffect(() => {
    setPage(1);
  }, [search, routeFilter, dateOrder, statusFilter]);

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  async function submitDecision(event) {
    event.preventDefault();
    if (!selected || selected.sample) return;
    setBusy(true);
    setActionError("");
    try {
      await caseWorkflowApi.recordDecision(selected.caseId, {
        expectedVersion: selected.version,
        outcome,
        reason: reason.trim(),
        conditions: [],
      });
      setMessage(`Final decision recorded for ${selected.applicationId}.`);
      setSelected(null);
      setReason("");
      await loadCases();
    } catch (submitError) {
      setActionError(submitError.message || "The decision could not be recorded.");
    } finally {
      setBusy(false);
    }
  }

  function clearFilters() {
    setSearch("");
    setRouteFilter("all");
    setDateOrder("newest");
    setStatusFilter("all");
  }

  return <section className="decisions-page">
    {error && <div className="decision-load-error" role="alert"><span>{error}</span><button className="button button-secondary button-small" onClick={loadCases}><RotateCw size={14} /> Retry</button></div>}

    <div className="decision-metrics">
      <MetricCard tone="amber" icon={Clock3} label="Awaiting decision" value={loading ? "—" : isDemo ? sampleRows.length : eligibleCases.length} note="Applications pending final decision" />
      <MetricCard tone="blue" icon={FileCheck2} label="Review routes complete" value={loading ? "—" : isDemo ? sampleRows.length : completedRouteCount} note="All configured review stages finished" />
      <MetricCard tone="green" icon={CheckCircle2} label="Route checks pending" value={loading ? "—" : isDemo ? "0" : routePendingCount} note="Cases still completing a review stage" />
    </div>

    <section className="decision-queue-card">
      <header className="decision-queue-heading">
        <span className="decision-queue-icon"><FileText size={22} /></span>
        <div><h2>Cases ready for decision</h2><p>Applications whose configured review route is complete and awaiting the Admin decision.</p></div>
        <div className="decision-queue-actions">
          <button className="button button-secondary button-small" type="button" onClick={loadCases}><RotateCw size={14} /> Refresh</button>
          <button className="button button-secondary button-small" type="button" onClick={() => exportCsv(filteredRows)} disabled={!filteredRows.length}><Download size={15} /> Export</button>
        </div>
      </header>

      <div className="decision-filters">
        <label className="decision-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by institution or application ID…" aria-label="Search institution or application ID" /></label>
        <label className="decision-select-label"><span className="sr-only">Review route</span><select value={routeFilter} onChange={(event) => setRouteFilter(event.target.value)} aria-label="Review route"><option value="all">Review route</option>{routeOptions.map((route) => <option key={route} value={route}>{route}</option>)}</select></label>
        <label className="decision-select-label"><CalendarDays size={14} /><select value={dateOrder} onChange={(event) => setDateOrder(event.target.value)} aria-label="Completed date order"><option value="newest">Completed date: newest</option><option value="oldest">Completed date: oldest</option></select></label>
        <label className="decision-select-label"><Filter size={14} /><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Decision status"><option value="all">Status: all</option><option value="awaiting">Awaiting decision</option></select></label>
        <button className="button button-secondary button-small decision-clear" type="button" onClick={clearFilters}><X size={14} /> Clear filters</button>
      </div>

      <div className="decision-table-wrap">
        <table className="decision-table">
          <thead><tr><th>#</th><th>Application / Institution</th><th>Application ID</th><th>Review route</th><th><button className="decision-sort" type="button" onClick={() => setDateOrder((value) => value === "newest" ? "oldest" : "newest")}>Completed on {dateOrder === "newest" ? <ArrowDown size={13} /> : <ArrowUp size={13} />}</button></th><th>Status</th><th>Action</th></tr></thead>
          <tbody>
            {loading ? <tr><td className="decision-empty" colSpan="7"><span className="loading-state"><i /><i /><i /></span><strong>Loading decision queue…</strong></td></tr>
              : visibleRows.length ? visibleRows.map((row, index) => <tr key={row.applicationId}>
                <td>{(page - 1) * PAGE_SIZE + index + 1}</td>
                <td><div className="decision-institution"><span className={`decision-institution-mark decision-mark-${index % 3}`}><Building2 size={17} /></span><span><strong>{row.institution}</strong><small>{row.region} · {row.applicationType}</small></span></div></td>
                <td>{row.sample ? <span className="decision-app-id">{row.applicationId}</span> : <Link className="decision-app-id" to={`/case/${row.caseId}`}>{row.applicationId}</Link>}</td>
                <td><span className="decision-route">{row.route}</span></td>
                <td><strong className="decision-date">{dateLabel(row.completedAt).split(",")[0]}</strong><small className="decision-time">{dateLabel(row.completedAt).split(",").slice(1).join(",").trim()}</small></td>
                <td><Badge variant="warning">{row.status}</Badge></td>
                <td>{row.sample
                  ? <button className="button button-primary button-small" type="button" disabled title="Sample rows are view-only">Preview only <ArrowRight size={14} /></button>
                  : <button className="button button-primary button-small decision-review-button" type="button" onClick={() => { setSelected(row); setOutcome("approved"); setReason(""); setActionError(""); }}>Review decision <ArrowRight size={15} /></button>}</td>
              </tr>)
                : <tr><td className="decision-empty" colSpan="7"><Search size={24} /><strong>No cases match these filters.</strong><span>Clear the filters or refresh the queue to see available applications.</span></td></tr>}
          </tbody>
        </table>
      </div>

      <footer className="decision-table-footer">
        <span><ShieldCheck size={15} /> Only applications with completed review routes are eligible for a final decision.</span>
        <div><small>{filteredRows.length ? `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, filteredRows.length)} of ${filteredRows.length} applications` : "0 applications"}</small>
          <button type="button" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={16} /></button>
          <span className="decision-page-number">{page}</span>
          <button type="button" aria-label="Next page" disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)}><ChevronRight size={16} /></button>
        </div>
      </footer>
    </section>

    {selected && <div className="decision-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setSelected(null); }}>
      <section className="decision-modal" role="dialog" aria-modal="true" aria-labelledby="decision-modal-title">
        <button className="decision-modal-close" type="button" onClick={() => setSelected(null)} aria-label="Close decision form" disabled={busy}><X size={18} /></button>
        <span className="decision-modal-icon"><Scale size={23} /></span>
        <p className="decision-modal-eyebrow">FINAL AUTHORITY REVIEW · {selected.applicationId}</p>
        <h2 id="decision-modal-title">Record final decision</h2>
        <p className="decision-modal-subtitle">{selected.institution} · {selected.applicationType}</p>
        <div className="decision-route-summary"><strong>Completed review route</strong><span>{selected.route}</span></div>
        {actionError && <p className="decision-action-error" role="alert">{actionError}</p>}
        <form onSubmit={submitDecision}>
          <label className="decision-form-label">Decision outcome
            <select value={outcome} onChange={(event) => setOutcome(event.target.value)}><option value="approved">Approve application</option><option value="rejected">Reject application</option></select>
          </label>
          <label className="decision-form-label">{outcome === "approved" ? "Reason for approval" : "Reason for rejection"}
            <textarea required minLength={1} maxLength={3000} rows={4} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Record the basis for this final decision…" />
          </label>
          <div className="decision-form-note"><ShieldCheck size={16} /><span>This decision is added to the application record and audit trail.</span></div>
          <div className="decision-modal-actions"><button className="button button-secondary" type="button" disabled={busy} onClick={() => setSelected(null)}>Cancel</button><button className="button button-primary" type="submit" disabled={busy || !reason.trim()}>{busy ? "Recording…" : "Record decision"}</button></div>
        </form>
      </section>
    </div>}
  </section>;
}
