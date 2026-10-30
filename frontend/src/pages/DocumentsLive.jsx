import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, ArrowDown, ArrowUp, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Clock3, Copy, Download, Eye, FileText, Search, X } from "lucide-react";
import { Badge, Card } from "../components/ui/primitives";
import DocumentEvidencePreview from "../components/DocumentEvidencePreview";
import DocumentPreviewDialog from "../components/DocumentPreviewDialog";
import { caseWorkflowApi } from "../services/caseWorkflow";

const applicationTypeLabels = {
  new_institution: "New institution",
  new_course: "New course",
  increase_in_intake: "Increase in intake",
  extension_of_approval: "Extension of approval",
  conversion_diploma_to_degree: "Conversion of diploma to degree",
  collaboration_twinning: "Collaboration or twinning programme",
  restoration_of_intake: "Restoration of intake",
};

const pageSize = 5;

function displayDate(value, options = { day: "2-digit", month: "short", year: "numeric" }) {
  if (!value) return "—";
  const date = parseDate(value);
  return date ? date.toLocaleDateString(undefined, options) : "—";
}

function displayDateTime(value) {
  if (!value) return "—";
  const date = parseDate(value);
  return !date
    ? "—"
    : `${date.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })} · ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

function parseDate(value) {
  if (!value) return null;
  const source = String(value).trim();
  const dayFirst = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(source);
  const date = dayFirst
    ? new Date(Number(dayFirst[3]), Number(dayFirst[2]) - 1, Number(dayFirst[1]))
    : new Date(source);
  return Number.isNaN(date.getTime()) ? null : date;
}

function displayLabel(value) {
  return String(value || "Not recorded").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function documentLabel(document) {
  return document.doc_type_final || document.doc_type_slot || document.original_name || "Application document";
}

function isRejected(document) {
  return document.status === "REJECTED" || document.verification === "not_verified";
}

function documentState(document) {
  if (isRejected(document)) return { label: "Rejected", variant: "danger" };
  if (document.verification === "verified") return { label: "Verified", variant: "success" };
  if (document.status === "CONFIRMED") return { label: "Awaiting confirmation", variant: "warning" };
  if (document.status === "AWAITING_CONFIRMATION") return { label: "Pending confirmation", variant: "warning" };
  if (document.status === "AI_FAILED") return { label: "Analysis failed", variant: "danger" };
  return { label: displayLabel(document.status || "Uploaded"), variant: "info" };
}

function validityDate(document) {
  const fields = document.extraction?.fields || [];
  const validityField = fields.find((field) => /valid.?to|validity|expir|lease.?end/i.test(field.field_name));
  return document.lease?.lease_end || validityField?.confirmed_value || validityField?.ai_value || "";
}

function validityState(value, now = new Date()) {
  if (!value) return "";
  const date = parseDate(value);
  if (!date) return "";
  const daysRemaining = Math.ceil((date.setHours(23, 59, 59, 999) - now.getTime()) / 86400000);
  return daysRemaining < 0 ? "expired" : daysRemaining <= 30 ? "expiring" : "";
}

async function loadAllPages(fetchPage, label) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const batch = await fetchPage({ page, pageSize: 100 });
    if (!Array.isArray(batch)) throw new Error(`The ${label} response was invalid.`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

function createApplicationRows(cases, documents) {
  const applications = new Map();
  for (const record of cases) {
    const id = String(record._id);
    applications.set(id, {
      id,
      applicationId: record.caseNo || id,
      kind: "case",
      record,
      institution: record.institutionId?.name || "",
      type: applicationTypeLabels[record.applicationType] || displayLabel(record.applicationType),
      status: record.status,
      submittedAt: record.submittedAt,
      currentStage: record.currentStage,
      updatedAt: record.updatedAt,
      documents: [],
    });
  }

  for (const document of documents) {
    const isCaseDocument = Boolean(document.case_id);
    const id = String(isCaseDocument ? document.case_id : document.application_id || "");
    if (!id) continue;
    let application = applications.get(id);
    if (!application) {
      const source = isCaseDocument ? document.case : document.application;
      application = {
        id,
        applicationId: source?.caseNo || source?.application_number || id,
        kind: isCaseDocument ? "case" : "application",
        record: source || null,
        institution: source?.institutionId?.name || source?.institution_id?.name || "",
        type: applicationTypeLabels[source?.applicationType || source?.type] || displayLabel(source?.applicationType || source?.type),
        status: source?.status || "",
        submittedAt: source?.submittedAt || source?.submitted_at || null,
        currentStage: source?.currentStage || source?.current_stage || "",
        updatedAt: document.createdAt,
        documents: [],
      };
      applications.set(id, application);
    }
    application.documents.push(document);
    if (document.createdAt && (!application.updatedAt || new Date(document.createdAt) > new Date(application.updatedAt))) {
      application.updatedAt = document.createdAt;
    }
  }

  return [...applications.values()].sort((left, right) => new Date(right.updatedAt || 0) - new Date(left.updatedAt || 0));
}

function documentValiditySummary(documents) {
  return documents.reduce((summary, document) => {
    const state = validityState(validityDate(document));
    if (state === "expired") summary.expired += 1;
    if (state === "expiring") summary.expiring += 1;
    return summary;
  }, { expired: 0, expiring: 0 });
}

function DocumentFieldsDialog({ document, onClose }) {
  const [sourceField, setSourceField] = useState(null);
  const [copyError, setCopyError] = useState("");
  const fields = document?.extraction?.fields || [];
  const selectedSource = fields.find((field) => field.field_name === sourceField);

  async function copyValue(field) {
    const value = field.confirmed_value ?? field.ai_value ?? "";
    if (!value) return;
    try {
      await navigator.clipboard.writeText(String(value));
      setCopyError("");
    } catch (error) {
      setCopyError(error.message || "The field value could not be copied.");
    }
  }

  return <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="document-fields-overlay" />
      <Dialog.Content className="document-fields-dialog" aria-describedby="document-fields-description">
        <header className="document-fields-header">
          <span className="document-preview-icon"><FileText size={19} /></span>
          <div>
            <Dialog.Title>Extracted fields</Dialog.Title>
            <Dialog.Description id="document-fields-description">{documentLabel(document)} · {document.original_name}</Dialog.Description>
          </div>
          <Dialog.Close className="document-preview-close" aria-label="Close extracted fields"><X size={19} /></Dialog.Close>
        </header>
        {fields.length
          ? <div className="document-fields-content">
            {copyError && <p className="alert alert-warning" role="alert">{copyError}</p>}
            <div className="document-fields-grid">
              {fields.map((field) => {
                const value = field.confirmed_value ?? field.ai_value ?? "";
                const confidence = Number(field.ai_confidence);
                const hasConfidence = Number.isFinite(confidence);
                const confidencePercent = hasConfidence ? Math.round((confidence <= 1 ? confidence : confidence / 100) * 100) : null;
                const canHighlight = Array.isArray(field.source_bbox) && field.source_bbox.length === 4;
                return <article className="document-field-card" key={`${document._id}-${field.field_name}`}>
                  <div><small>{displayLabel(field.field_name)}</small>
                    <strong>{value || "No value extracted"}</strong>
                  </div>
                  <div className="document-field-actions">
                    {hasConfidence && <span className="document-field-confidence">{confidencePercent}%</span>}
                    <button className="icon-button" type="button" aria-label={`Copy ${displayLabel(field.field_name)}`} disabled={!value} onClick={() => copyValue(field)}><Copy size={14} /></button>
                    {canHighlight && <button className="text-link" type="button" onClick={() => setSourceField(field.field_name)}>{sourceField === field.field_name ? "Highlighted" : "Source highlight"}</button>}
                  </div>
                </article>;
              })}
            </div>
            {selectedSource && <DocumentEvidencePreview
              documentId={document._id}
              fileName={document.original_name}
              page={selectedSource.source_page || 1}
              bbox={selectedSource.source_bbox}
              confidence={selectedSource.ai_confidence}
              showSourceDetails
              onClose={() => setSourceField(null)}
            />}
          </div>
          : <div className="document-fields-empty"><AlertTriangle size={25} /><strong>No extracted fields available</strong><span>Fields will appear here after this document has been analyzed.</span></div>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function ApplicationSummary({ application, documents }) {
  const stats = [
    { label: "Total documents", value: documents.length, icon: FileText, tone: "blue", note: "Uploaded to this application" },
    { label: "Verified", value: documents.filter((document) => document.verification === "verified").length, icon: CheckCircle2, tone: "green", note: "Officially verified" },
    { label: "Awaiting confirmation", value: documents.filter((document) => !isRejected(document) && document.verification !== "verified").length, icon: Clock3, tone: "amber", note: "Need manual review" },
    { label: "Rejected", value: documents.filter(isRejected).length, icon: AlertTriangle, tone: "red", note: "Require attention" },
  ];
  const caseRecord = application.record;
  const institution = application.institution || caseRecord?.institutionName || caseRecord?.institutionId?.name;
  return <>
    <div className="document-application-summary">
      <div className="document-application-identity">
        <span className="document-application-icon"><FileText size={21} /></span>
        <div><strong>{application.applicationId}</strong><small>{institution || "Institution name not available"}</small></div>
        <Badge variant={application.status === "approved" || application.status === "APPROVED" ? "success" : application.status === "rejected" || application.status === "REJECTED" ? "danger" : "info"}>{displayLabel(application.status || "In progress")}</Badge>
      </div>
      <dl className="document-application-meta">
        <div><dt>Application type</dt><dd>{application.type}</dd></div>
        <div><dt>Policy version</dt><dd>{caseRecord?.policyVersion || "—"}</dd></div>
        <div><dt>Submitted on</dt><dd>{displayDate(application.submittedAt)}</dd></div>
        <div><dt>Current stage</dt><dd>{displayLabel(application.currentStage || "Not assigned")}</dd></div>
      </dl>
    </div>
    <div className="document-application-stats">
      {stats.map(({ label, value, icon: Icon, tone, note }) => <article className={`document-register-stat ${tone}`} key={label}>
        <span className="document-register-stat-icon"><Icon size={20} /></span>
        <div><small>{label}</small><strong>{String(value).padStart(2, "0")}</strong><span>{note}</span></div>
      </article>)}
    </div>
  </>;
}

function DocumentRegisterTable({ applications, onExport }) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortOrder, setSortOrder] = useState("recent");
  const [page, setPage] = useState(1);
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    const result = applications.filter((application) => {
      const matchesSearch = !search || [application.applicationId, application.institution, application.type]
        .some((value) => value?.toLocaleLowerCase().includes(search));
      const verified = application.documents.filter((document) => document.verification === "verified").length;
      const rejected = application.documents.some(isRejected);
      const matchesStatus = statusFilter === "all"
        || statusFilter === "verified" && verified === application.documents.length && application.documents.length > 0
        || statusFilter === "pending" && application.documents.some((document) => document.verification !== "verified" && !isRejected(document))
        || statusFilter === "rejected" && rejected;
      return matchesSearch && matchesStatus;
    });
    return result.sort((left, right) => {
      const comparison = new Date(right.updatedAt || 0) - new Date(left.updatedAt || 0);
      return sortOrder === "oldest" ? -comparison : comparison;
    });
  }, [applications, query, statusFilter, sortOrder]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visible = filtered.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => setPage(1), [query, statusFilter, sortOrder]);

  return <Card className="document-register-card" title="Your applications" description="Select an application to review its uploaded documents, verification status, and extracted fields." action={<button className="button button-secondary button-small" type="button" onClick={onExport}><Download size={14} /> Export CSV</button>}>
    <div className="document-register-toolbar">
      <label className="document-register-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by application ID or institution…" aria-label="Search applications" /></label>
      <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Filter applications by document status">
        <option value="all">All statuses</option><option value="verified">Verified</option><option value="pending">Awaiting confirmation</option><option value="rejected">Rejected</option>
      </select>
      <button className="button button-secondary button-small document-sort-button" type="button" onClick={() => setSortOrder((current) => current === "recent" ? "oldest" : "recent")}>
        {sortOrder === "recent" ? <ArrowDown size={14} /> : <ArrowUp size={14} />} {sortOrder === "recent" ? "Recently updated" : "Oldest updated"}
      </button>
    </div>
    {visible.length
      ? <div className="document-register-table-wrap"><table className="document-register-table">
        <thead><tr><th>#</th><th>Application ID</th><th>Application type</th><th>Submitted</th><th>Documents</th><th>Verification</th><th>Last updated</th><th>Action</th></tr></thead>
        <tbody>{visible.map((application, index) => {
          const verified = application.documents.filter((document) => document.verification === "verified").length;
          const pending = application.documents.filter((document) => document.verification !== "verified" && !isRejected(document)).length;
          const rejected = application.documents.filter(isRejected).length;
          return <tr key={application.id}>
            <td>{(page - 1) * pageSize + index + 1}</td>
            <td><Link className="document-application-link" to={`/documents/${encodeURIComponent(application.id)}`} state={{ applicationId: application.applicationId }}>{application.applicationId}</Link><small>{application.institution || "Institution name unavailable"}</small></td>
            <td>{application.type}</td>
            <td>{displayDate(application.submittedAt)}</td>
            <td><span className="document-count-cell"><FileText size={16} />{application.documents.length} {application.documents.length === 1 ? "document" : "documents"}</span></td>
            <td>{!application.documents.length
              ? <Badge variant="neutral">No documents</Badge>
              : rejected
              ? <Badge variant="danger">{rejected} rejected</Badge>
              : pending
                ? <Badge variant="warning">{verified} verified / {pending} pending</Badge>
                : <Badge variant="success">Verified</Badge>}</td>
            <td>{displayDateTime(application.updatedAt)}</td>
            <td><Link className="button button-primary button-small" to={`/documents/${encodeURIComponent(application.id)}`} state={{ applicationId: application.applicationId }}>View documents <ChevronRight size={14} /></Link></td>
          </tr>;
        })}</tbody>
      </table></div>
      : <div className="document-register-empty"><FileText size={25} /><strong>No applications match these filters</strong><span>Try a different search or status filter.</span></div>}
    <footer className="document-register-pagination">
      <span>Showing {filtered.length ? (page - 1) * pageSize + 1 : 0}–{Math.min(page * pageSize, filtered.length)} of {filtered.length} applications</span>
      <div>
        <button className="icon-button" type="button" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}><ChevronLeft size={16} /></button>
        <span>Page {page} of {pages}</span>
        <button className="icon-button" type="button" aria-label="Next page" disabled={page >= pages} onClick={() => setPage((current) => current + 1)}><ChevronRight size={16} /></button>
      </div>
    </footer>
  </Card>;
}

function ApplicationDocuments({ caseRecord, documents, onPreview, onFields }) {
  const [tab, setTab] = useState("all");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortOrder, setSortOrder] = useState("recent");
  const checklist = caseRecord?.checklist || [];
  const filteredDocuments = useMemo(() => documents.filter((document) => {
    const label = documentLabel(document);
    const matchesTab = tab === "all"
      || tab === "verified" && document.verification === "verified"
      || tab === "pending" && document.verification !== "verified" && !isRejected(document)
      || tab === "rejected" && isRejected(document);
    const matchesSearch = !query.trim() || `${label} ${document.original_name}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
    const matchesType = typeFilter === "all" || document.doc_type_slot === typeFilter || document.doc_type_final === typeFilter;
    const matchesStatus = statusFilter === "all" || documentState(document).label === statusFilter;
    return matchesTab && matchesSearch && matchesType && matchesStatus;
  }).sort((left, right) => {
    const comparison = new Date(right.createdAt || 0) - new Date(left.createdAt || 0);
    return sortOrder === "oldest" ? -comparison : comparison;
  }), [documents, query, sortOrder, statusFilter, tab, typeFilter]);
  const counts = {
    all: documents.length,
    verified: documents.filter((document) => document.verification === "verified").length,
    pending: documents.filter((document) => document.verification !== "verified" && !isRejected(document)).length,
    rejected: documents.filter(isRejected).length,
  };
  const documentTypes = [...new Set(documents.flatMap((document) => [document.doc_type_final || document.doc_type_slot]).filter(Boolean))].sort();
  const validCount = documentValiditySummary(documents);

  return <section className="application-document-content">
    <div className="application-document-toolbar">
      <nav className="application-document-tabs" aria-label="Document status filters">
        {[["all", "All documents"], ["verified", "Verified"], ["pending", "Pending"], ["rejected", "Rejected"]].map(([key, label]) => <button className={tab === key ? "active" : ""} type="button" key={key} onClick={() => setTab(key)}>{label} <span>{counts[key]}</span></button>)}
      </nav>
      <label className="document-register-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search document name…" aria-label="Search documents" /></label>
      <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} aria-label="Filter by document type"><option value="all">All document types</option>{documentTypes.map((type) => <option value={type} key={type}>{displayLabel(type)}</option>)}</select>
      <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Filter by document status"><option value="all">All statuses</option>{[...new Set(documents.map((document) => documentState(document).label))].map((status) => <option value={status} key={status}>{status}</option>)}</select>
      <button className="button button-secondary button-small" type="button" onClick={() => setSortOrder((current) => current === "recent" ? "oldest" : "recent")}>{sortOrder === "recent" ? <ArrowDown size={14} /> : <ArrowUp size={14} />} Sort by</button>
    </div>
    <div className="application-document-validity">
      <CalendarDays size={15} />
      <span>Validity overview</span>
      <strong>{validCount.expired} expired</strong>
      <strong>{validCount.expiring} expiring within 30 days</strong>
    </div>
    <div className="application-documents-table-wrap"><table className="application-documents-table">
      <thead><tr><th>#</th><th>Document name</th><th>Document type</th><th>Uploaded on</th><th>Validity</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>{filteredDocuments.map((document, index) => {
        const state = documentState(document);
        const slot = checklist.find((item) => item.slotId === document.doc_type_slot);
        const validTo = validityDate(document);
        const expiry = validityState(validTo);
        return <tr key={document._id}>
          <td>{index + 1}</td>
          <td><span className="document-table-name"><FileText size={17} /><span><strong>{documentLabel(document)}</strong><small>{document.original_name}</small></span></span></td>
          <td><span className="document-type-tag">{slot ? slot.required ? "Mandatory" : "Optional" : "Document"}</span></td>
          <td>{displayDateTime(document.createdAt)}</td>
          <td><span className={`document-validity-value${expiry ? ` ${expiry}` : ""}`}>{displayDate(validTo)}</span></td>
          <td><Badge variant={state.variant}>{state.label}</Badge></td>
          <td><div className="application-document-actions">
            <button className="button button-secondary button-small" type="button" onClick={() => onPreview(document)}><Eye size={14} /> View document</button>
            <button className="button button-secondary button-small" type="button" onClick={() => onFields(document)}><FileText size={14} /> View fields</button>
          </div></td>
        </tr>;
      })}</tbody>
    </table></div>
    {!filteredDocuments.length && <div className="document-register-empty"><FileText size={24} /><strong>No documents found</strong><span>There are no documents matching the selected filters.</span></div>}
  </section>;
}

export default function DocumentsLive({ title = "Documents and validity", allowNewApplication = true }) {
  const { applicationId } = useParams();
  const [applications, setApplications] = useState(null);
  const [caseRecord, setCaseRecord] = useState(null);
  const [detailDocuments, setDetailDocuments] = useState(null);
  const [error, setError] = useState("");
  const [selectedDocument, setSelectedDocument] = useState(null);
  const [fieldsDocument, setFieldsDocument] = useState(null);

  const loadRegister = useCallback(async () => {
    setError("");
    setApplications(null);
    try {
      const [allDocuments, allCases] = await Promise.all([
        loadAllPages(caseWorkflowApi.listDocuments, "document list"),
        loadAllPages(caseWorkflowApi.listCases, "application list"),
      ]);
      setApplications(createApplicationRows(allCases, allDocuments));
    } catch (loadError) {
      setError(loadError.message || "Applications and documents could not be loaded.");
      setApplications([]);
    }
  }, []);

  useEffect(() => {
    loadRegister();
  }, [loadRegister]);

  useEffect(() => {
    if (!applicationId || !applications) {
      setCaseRecord(null);
      setDetailDocuments(null);
      return;
    }
    let active = true;
    setError("");
    setCaseRecord(null);
    setDetailDocuments(null);
    const application = applications.find((item) => item.id === applicationId || item.applicationId === applicationId);
    if (!application) {
      setError("This application was not found in your authorized document register.");
      setDetailDocuments([]);
      return () => { active = false; };
    }
    if (application.kind !== "case") {
      setCaseRecord(application.record);
      setDetailDocuments(application.documents);
      return () => { active = false; };
    }
    Promise.all([
      caseWorkflowApi.getCase(application.id),
      caseWorkflowApi.getCaseDocuments(application.id),
    ]).then(([record, caseDocuments]) => {
      if (!Array.isArray(caseDocuments)) throw new Error("The application documents response was invalid.");
      if (!active) return;
      setCaseRecord(record);
      setDetailDocuments(caseDocuments);
    }).catch((loadError) => {
      if (active) {
        setError(loadError.message || "Application documents could not be loaded.");
        setDetailDocuments([]);
      }
    });
    return () => { active = false; };
  }, [applicationId, applications]);

  const selectedApplication = useMemo(() => (applications || []).find((item) => item.id === applicationId || item.applicationId === applicationId) || null, [applications, applicationId]);

  function exportApplications() {
    const headings = ["Application ID", "Institution", "Application type", "Status", "Document count", "Verified", "Awaiting confirmation", "Rejected", "Last updated"];
    const rows = (applications || []).map((application) => {
      const verified = application.documents.filter((document) => document.verification === "verified").length;
      const rejected = application.documents.filter(isRejected).length;
      const pending = application.documents.length - verified - rejected;
      return [application.applicationId, application.institution, application.type, application.status, application.documents.length, verified, pending, rejected, application.updatedAt || ""];
    });
    const csv = [headings, ...rows].map((row) => row.map((value) => `"${String(value ?? "").replaceAll("\"", "\"\"")}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.download = "documents-validity-register.csv";
    window.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (applications === null) {
    return <Card title={title}><div className="loading-state" aria-label="Loading applications and documents"><i /><i /><i /></div></Card>;
  }

  if (error && applications.length === 0) {
    return <Card title={title}><div className="state-card state-error" role="alert"><AlertTriangle size={22} /><h3>Document register unavailable</h3><p>{error}</p><button className="button button-secondary" type="button" onClick={loadRegister}>Retry</button></div></Card>;
  }

  if (applicationId) {
    if (!selectedApplication) return <Card title="Application unavailable"><div className="state-card state-error" role="alert"><AlertTriangle size={22} /><p>{error || "This application was not found in your authorized document register."}</p><Link className="button button-secondary" to="/documents"><ChevronLeft size={15} /> Back to applications</Link></div></Card>;
    if (detailDocuments === null) return <Card title="Loading application documents"><div className="loading-state" aria-label="Loading application documents"><i /><i /><i /></div></Card>;
    return <div className="application-documents-page">
      {error && <div className="alert alert-warning" role="alert">{error}</div>}
      <ApplicationSummary application={{
        ...selectedApplication,
        record: caseRecord || selectedApplication.record,
        status: caseRecord?.status || selectedApplication.status,
        submittedAt: caseRecord?.submittedAt || selectedApplication.submittedAt,
        currentStage: caseRecord?.currentStage || selectedApplication.currentStage,
      }} documents={detailDocuments} />
      <Card className="application-documents-card" title="Application documents" description={`${selectedApplication.applicationId} · ${detailDocuments.length} uploaded ${detailDocuments.length === 1 ? "document" : "documents"}`}>
        <ApplicationDocuments caseRecord={caseRecord} documents={detailDocuments} onPreview={setSelectedDocument} onFields={setFieldsDocument} />
      </Card>
      {selectedDocument && <DocumentPreviewDialog document={{ documentId: selectedDocument._id, fileName: selectedDocument.original_name, mimeType: selectedDocument.mime }} onClose={() => setSelectedDocument(null)} />}
      {fieldsDocument && <DocumentFieldsDialog document={fieldsDocument} onClose={() => setFieldsDocument(null)} />}
    </div>;
  }

  const allDocuments = applications.flatMap((application) => application.documents);
  const verifiedCount = allDocuments.filter((document) => document.verification === "verified").length;
  const pendingCount = allDocuments.filter((document) => document.verification !== "verified" && !isRejected(document)).length;
  const validity = documentValiditySummary(allDocuments);
  return <div className="documents-validity-page">
    {error && <div className="alert alert-warning" role="alert">{error}<button className="text-link" type="button" onClick={loadRegister}>Retry</button></div>}
    <div className="documents-validity-stats">
      <article className="document-register-stat blue"><span className="document-register-stat-icon"><FileText size={20} /></span><div><small>Applications</small><strong>{String(applications.length).padStart(2, "0")}</strong><span>In your authorized workspace</span></div></article>
      <article className="document-register-stat green"><span className="document-register-stat-icon"><CheckCircle2 size={20} /></span><div><small>Verified documents</small><strong>{String(verifiedCount).padStart(2, "0")}</strong><span>Across all applications</span></div></article>
      <article className="document-register-stat amber"><span className="document-register-stat-icon"><Clock3 size={20} /></span><div><small>Awaiting confirmation</small><strong>{String(pendingCount).padStart(2, "0")}</strong><span>Need manual review</span></div></article>
      <article className="document-register-stat red"><span className="document-register-stat-icon"><AlertTriangle size={20} /></span><div><small>Expired / expiring</small><strong>{String(validity.expired + validity.expiring).padStart(2, "0")}</strong><span>{validity.expired} expired · {validity.expiring} expiring soon</span></div></article>
    </div>
    {applications.length
      ? <DocumentRegisterTable applications={applications} onExport={exportApplications} />
      : <Card title="Your applications" description="Applications and their uploaded documents will appear here." action={allowNewApplication ? <Link className="button button-primary button-small" to="/applications/new">New application</Link> : null}>
        <div className="document-register-empty"><FileText size={26} /><strong>No applications found</strong><span>There are no applications or uploaded documents in your authorized scope.</span></div>
      </Card>}
  </div>;
}
