import { useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import * as RadixToast from "@radix-ui/react-toast";
import * as Tooltip from "@radix-ui/react-tooltip";
import * as Tabs from "@radix-ui/react-tabs";
import { flexRender, getCoreRowModel, getFilteredRowModel, getPaginationRowModel, getSortedRowModel, useReactTable } from "@tanstack/react-table";
import { AlertCircle, ArrowDown, ArrowUp, CheckCircle2, Circle, Clock3, Info, ShieldCheck, Sparkles, UploadCloud, XCircle } from "lucide-react";
import { getDeadlineState } from "../../utils/deadline";

const badgeIcons = {
  success: CheckCircle2, warning: Clock3, danger: XCircle, info: Info, neutral: Circle, ai: Sparkles, review: ShieldCheck,
};

export function Badge({ variant = "neutral", children, icon: Icon, ...props }) {
  const Mark = Icon || badgeIcons[variant] || Circle;
  return <span className={`badge badge-${variant}`} {...props}><Mark size={14} aria-hidden="true" />{children}</span>;
}

export function Card({ title, description, action, className = "", children }) {
  return <section className={`card ${className}`}><div className="card-heading">{title && <div><h2>{title}</h2>{description && <p>{description}</p>}</div>}{action}</div>{children}</section>;
}

export function SectionTitle({ title, description, action }) {
  return <div className="section-title"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</div>;
}

export function StatCard({ label, value, note, icon: Icon, variant = "info" }) {
  return <article className="stat-card"><div className="stat-top"><span>{label}</span>{Icon && <span className="stat-icon"><Icon size={17} /></span>}</div><strong>{value}</strong>{note && <small>{note}</small>}</article>;
}

export function DeadlineBadge({ deadline, now }) {
  const state = getDeadlineState(deadline, now);
  if (state.kind === "missing") return <Badge variant="neutral" icon={AlertCircle}>{state.label}</Badge>;
  return <Badge variant={state.kind === "overdue" ? "danger" : state.kind === "due" ? "warning" : "info"}>{state.label}</Badge>;
}

export function OwnershipClockBar({ institutionDays, officerDays }) {
  const total = institutionDays + officerDays;
  const institutionWidth = total ? (institutionDays / total) * 100 : 0;
  return <div className="ownership-clock" aria-label={`${institutionDays} days institution-held, ${officerDays} days officer-held`}><div className="clock-track"><span className="clock-institution" style={{ width: `${institutionWidth}%` }} /><span className="clock-officer" style={{ width: `${total ? 100 - institutionWidth : 0}%` }} /></div><div className="clock-legend"><span><i className="clock-institution-dot" />Institution <strong>{institutionDays}d</strong></span><span><i className="clock-officer-dot" />Officer / Committee <strong>{officerDays}d</strong></span></div></div>;
}

export function StageStepper({ route, current, holder = "Officer", returnedReason, className = "" }) {
  const index = route.indexOf(current);
  return <ol className={`stage-stepper ${className}`.trim()} aria-label="Case stages">{route.map((stage, stepIndex) => {
    const state = stage === current ? "current" : stepIndex < index ? "done" : "upcoming";
    return <li className={`step step-${state}`} key={stage} tabIndex="0" title={state === "current" ? `Current holder: ${holder}` : stage === "Re-Scrutiny" && returnedReason ? returnedReason : stage}><span className="step-mark">{state === "done" ? <CheckCircle2 size={15} /> : stepIndex + 1}</span><span className="step-text"><strong>{stage}</strong>{state === "current" && <small>{holder} · current</small>}</span></li>;
  })}</ol>;
}

export function ScoreGauge({ score, onBreakdown }) {
  const band = score >= 80 ? "Lower action burden" : score >= 50 ? "Attention needed" : "High action burden";
  return <div className={`score-gauge score-${score >= 80 ? "good" : score >= 50 ? "attention" : "high"}`}><div className="score-ring" style={{ "--score-progress": `${score}%` }}><strong>{score}</strong><small>/ 100</small></div><Badge variant={score >= 80 ? "success" : score >= 50 ? "warning" : "danger"}>{band}</Badge><button className="text-link" onClick={onBreakdown}>How is this calculated?</button></div>;
}

export function ScoreBreakdownTable({ deductions, onLeaseConfirm }) {
  const labels = [["Undertakings", "undertakings"], ["Non-lease documents", "nonLeaseDocuments"], ["Lease", "lease"], ["Institution EVC readiness", "evcReadiness"], ["History", "history"]];
  return <div className="table-wrap"><table className="data-table"><thead><tr><th>Category</th><th>Item</th><th>Points</th><th>Cap</th><th>Record</th></tr></thead><tbody>{labels.map(([label, key]) => {
    const points = deductions[key] || 0;
    return <tr key={key}><td>{label}</td><td>{key === "lease" && points === 0 ? <Badge variant="review">Under review</Badge> : `${label} actions`}</td><td className="mono">{points}</td><td className="mono">{key === "lease" ? 10 : 30}</td><td>{key === "lease" && points === 0 ? <button className="text-link" onClick={onLeaseConfirm}>Confirm flag</button> : <a className="text-link" href="#documents">View record</a>}</td></tr>;
  })}</tbody></table></div>;
}

export function ProjectedScoreCard({ score, date, current = 63 }) {
  return <Card className="projected-card" title="Projected Action Score" description="Based on known obligation dates"><div className="projected-values"><div><small>Today</small><strong>{current}</strong></div><svg className="projection-chart" viewBox="0 0 80 30" role="img" aria-label="Projected score trend"><path d="M2 5 C 20 7, 25 10, 38 14 S 60 23, 78 27" /><circle cx="78" cy="27" r="2.5" /></svg><div><small>In 30 days</small><strong>{score}</strong></div></div><p>If nothing changes, your score will be {score} on {date}.</p><small className="muted">This is a calculation from known dates, not a prediction.</small></Card>;
}

export function DataTable({ data = [], columns, emptyText = "No records match these filters.", onExport }) {
  const [globalFilter, setGlobalFilter] = useState("");
  const table = useReactTable({ data, columns, state: { globalFilter }, onGlobalFilterChange: setGlobalFilter, getCoreRowModel: getCoreRowModel(), getFilteredRowModel: getFilteredRowModel(), getSortedRowModel: getSortedRowModel(), getPaginationRowModel: getPaginationRowModel() });
  const csv = useMemo(() => data.map((row) => columns.map((column) => row[column.accessorKey] ?? "").join(",")).join("\n"), [data, columns]);
  return <div className="table-shell"><div className="table-tools"><label className="input-search">Search records<input value={globalFilter} onChange={(event) => setGlobalFilter(event.target.value)} placeholder="Search…" /></label><div className="tool-actions"><button className="button button-secondary button-small" onClick={() => onExport ? onExport() : downloadCsv(csv)}>Export CSV</button><label className="density-select">Density<select aria-label="Table density"><option>Comfortable</option><option>Compact</option></select></label></div></div><div className="table-wrap"><table className="data-table"><thead>{table.getHeaderGroups().map((group) => <tr key={group.id}>{group.headers.map((header) => <th key={header.id}><button className="sort-button" onClick={header.column.getToggleSortingHandler()}>{flexRender(header.column.columnDef.header, header.getContext())}{header.column.getIsSorted() === "asc" ? <ArrowUp size={13} /> : header.column.getIsSorted() === "desc" ? <ArrowDown size={13} /> : null}</button></th>)}</tr>)}</thead><tbody>{table.getRowModel().rows.length ? table.getRowModel().rows.map((row) => <tr key={row.id}>{row.getVisibleCells().map((cell) => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr>) : <tr><td className="empty-cell" colSpan={columns.length}>{emptyText}</td></tr>}</tbody></table></div><div className="table-pagination"><span>Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount() || 1}</span><div><button className="button button-secondary button-small" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>Previous</button><button className="button button-secondary button-small" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>Next</button></div></div></div>;
}

function downloadCsv(csv) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "approvaltrack-export.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

export function TabsView({ items, children }) {
  return <Tabs.Root defaultValue={items[0]}><Tabs.List className="tabs-list">{items.map((item) => <Tabs.Trigger className="tab-trigger" value={item} key={item}>{item}</Tabs.Trigger>)}</Tabs.List>{items.map((item) => <Tabs.Content value={item} key={item}>{typeof children === "function" ? children(item) : children}</Tabs.Content>)}</Tabs.Root>;
}

export function ReasonDialog({ open, onOpenChange, onConfirm }) {
  const [reason, setReason] = useState("");
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content"><Dialog.Title>Return case with reason</Dialog.Title><Dialog.Description>Provide the written reason that will be recorded in the audit trail.</Dialog.Description><label className="field-label">Reason<textarea value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} placeholder="Describe the deficiency and the required action…" /></label><div className="dialog-footer"><small>{reason.length}/500 characters</small><button className="button button-primary" disabled={!reason.trim()} onClick={() => { onConfirm(reason.trim()); setReason(""); }}>Confirm return</button></div><Dialog.Close className="dialog-close" aria-label="Close"><XCircle size={18} /></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>;
}

export function ConfirmDialog({ title, description, open, onOpenChange, onConfirm }) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content"><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description><div className="dialog-footer"><Dialog.Close asChild><button className="button button-secondary">Cancel</button></Dialog.Close><button className="button button-primary" onClick={onConfirm}>Confirm</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>;
}

export function AIFieldRow({ label, value, confidence = 0.91, model = "M2 Field extraction · v1.4", aiEnabled = true, onConfirm }) {
  const confidenceLabel = confidence >= .9 ? "Pre-filled" : confidence >= .6 ? "Please check" : "Low confidence";
  const variant = confidence >= .9 ? "success" : confidence >= .6 ? "warning" : "danger";
  return <div className="ai-field-row"><div className="ai-field-heading"><strong>{label}</strong><Badge variant="ai">AI-suggested</Badge></div>{aiEnabled ? <><div className="ai-field-value">{confidence < .6 ? <span className="muted">No value proposed</span> : value}</div><div className="ai-field-meta"><Badge variant={variant}>{confidenceLabel} · {confidence.toFixed(2)}</Badge><small>{model}</small></div><button className="button button-secondary button-small" disabled={confidence < .6} onClick={() => onConfirm?.(value)}>Confirm</button></> : <p className="muted">AI service unavailable. Enter values manually.</p>}</div>;
}

export function Toast({ message, onClose }) {
  if (!message) return null;
  return <RadixToast.Provider swipeDirection="right"><RadixToast.Root className="toast" open duration={4000} onOpenChange={(open) => { if (!open) onClose(); }}><CheckCircle2 size={17} /><RadixToast.Title>{message}</RadixToast.Title><RadixToast.Close aria-label="Dismiss">×</RadixToast.Close></RadixToast.Root><RadixToast.Viewport className="toast-viewport" /></RadixToast.Provider>;
}

export function TooltipButton({ label, children }) {
  return <Tooltip.Provider delayDuration={300}><Tooltip.Root><Tooltip.Trigger asChild>{children}</Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="tooltip-content" sideOffset={5}>{label}<Tooltip.Arrow className="tooltip-arrow" /></Tooltip.Content></Tooltip.Portal></Tooltip.Root></Tooltip.Provider>;
}

export function HelpPopover({ label = "More information", children }) {
  return <Popover.Root><Popover.Trigger className="text-link">{label}</Popover.Trigger><Popover.Portal><Popover.Content className="popover-content" sideOffset={7}>{children}<Popover.Arrow className="tooltip-arrow" /></Popover.Content></Popover.Portal></Popover.Root>;
}

export function FileDropzone({ onFile, maxSizeMb = 20, accept = ".pdf,.png,.jpg,.jpeg" }) {
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [quarantined, setQuarantined] = useState(false);
  const [progress, setProgress] = useState(0);

  function selectFile(file) {
    setError("");
    setQuarantined(false);
    setProgress(0);
    if (!file) return;
    if (/\.(exe|com|bat|cmd|scr|msi)$/i.test(file.name)) {
      setFileName(file.name);
      setQuarantined(true);
      setError(`${file.name} was quarantined as a suspicious file. It was not opened or processed.`);
      onFile?.(null, { quarantined: true, fileName: file.name });
      return;
    }
    if (!/\.(pdf|png|jpe?g)$/i.test(file.name)) {
      setError("Unsupported file type. Upload a PDF or image file.");
      return;
    }
    if (file.size > maxSizeMb * 1024 * 1024) {
      setError(`File exceeds the ${maxSizeMb} MB limit.`);
      return;
    }
    setFileName(file.name);
    setProgress(20);
    onFile?.(file, { quarantined: false, fileName: file.name });
    window.setTimeout(() => setProgress(100), 250);
  }

  return <div className={`file-dropzone ${dragging ? "dragging" : ""} ${quarantined ? "quarantined" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); selectFile(event.dataTransfer.files[0]); }}>
    <UploadCloud size={23} /><strong>{fileName || "Drop a document here or browse"}</strong><small>PDF or image · maximum {maxSizeMb} MB</small>
    <label className="button button-secondary button-small">Choose file<input type="file" accept={accept} onChange={(event) => selectFile(event.target.files?.[0])} /></label>
    {progress > 0 && !quarantined && <div className="upload-progress" role="progressbar" aria-valuenow={progress} aria-valuemin="0" aria-valuemax="100"><i style={{ width: `${progress}%` }} /></div>}
    {error && <p className={quarantined ? "danger-copy" : "field-error"} role="alert">{error}</p>}
  </div>;
}
