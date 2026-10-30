import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, FileText } from "lucide-react";
import { Badge, Card } from "../components/ui/primitives";
import { caseWorkflowApi } from "../services/caseWorkflow";

function applicationKey(document) {
  if (document.case_id) return `case:${document.case_id}`;
  if (document.application_id) return `application:${document.application_id}`;
  return null;
}

function documentStatusVariant(status) {
  if (["CONFIRMED", "AI_DONE"].includes(status)) return "success";
  if (["REJECTED", "AI_FAILED", "QUARANTINED"].includes(status)) return "danger";
  if (status === "SUPERSEDED") return "neutral";
  return "warning";
}

export default function VerificationWorkspace({ cases = [] }) {
  const [documents, setDocuments] = useState(null);
  const [error, setError] = useState("");
  const [selectedKey, setSelectedKey] = useState("");

  const loadDocuments = useCallback(async () => {
    setError("");
    setDocuments(null);
    try {
      const allDocuments = [];
      let page = 1;
      let pageDocuments;
      do {
        pageDocuments = await caseWorkflowApi.listDocuments({ page, pageSize: 100 });
        if (!Array.isArray(pageDocuments)) throw new Error("The document list response was invalid.");
        allDocuments.push(...pageDocuments);
        page += 1;
      } while (pageDocuments.length === 100);
      setDocuments(allDocuments);
    } catch (loadError) {
      setError(loadError.message || "Verification documents could not be loaded.");
      setDocuments([]);
    }
  }, []);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  const applications = useMemo(() => {
    const groups = new Map();
    for (const item of cases) {
      const key = `case:${item.caseId}`;
      groups.set(key, {
        key,
        id: item.id,
        name: item.institution || "Institution",
        type: item.type || "Application",
        stage: item.stage || "",
        status: item.status || "",
        documents: [],
      });
    }
    for (const document of documents || []) {
      const key = applicationKey(document);
      if (!key) continue;
      const group = groups.get(key) || {
        key,
        id: document.application?.application_number || document.case?.caseNo || document.application_id || document.case_id,
        name: document.application?.institution?.name || "Institution",
        type: document.application?.type || document.case?.applicationType || "Application",
        stage: document.application?.current_stage || document.case?.currentStage || "",
        status: document.application?.status || document.case?.status || "",
        documents: [],
      };
      group.documents.push(document);
      groups.set(key, group);
    }
    return [...groups.values()].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  }, [cases, documents]);

  useEffect(() => {
    if (!applications.some((application) => application.key === selectedKey)) {
      setSelectedKey(applications[0]?.key || "");
    }
  }, [applications, selectedKey]);

  const selected = applications.find((application) => application.key === selectedKey);

  if (documents === null) {
    return <Card title="Verification documents"><div className="loading-state" aria-label="Loading documents"><i /><i /><i /></div></Card>;
  }

  return <div className="split-content">
    <Card title="Applications" description="Select an application to review its uploaded documents and verification status.">
      {error && <div className="note warning-note" role="alert">{error}<button className="text-link" onClick={loadDocuments}>Retry</button></div>}
      {!error && applications.length === 0
        ? <div className="state-card"><FileText size={22} /><h3>No applications found</h3><p>Applications in your authorized verification scope will appear here.</p></div>
        : <div className="queue-list">{applications.map((application) => (
          <button
            className={`verification-record ${application.key === selectedKey ? "selected" : ""}`}
            key={application.key}
            onClick={() => setSelectedKey(application.key)}
            aria-pressed={application.key === selectedKey}
          >
            <FileText size={17} />
            <span><strong>{application.id}</strong><small>{application.name} · {application.type}</small></span>
            <Badge variant={application.documents.length ? "info" : "neutral"}>{application.documents.length} documents</Badge>
          </button>
        ))}</div>}
      <button className="text-link" onClick={loadDocuments}>Refresh documents</button>
    </Card>
    <Card
      title={selected ? `Documents for ${selected.id}` : "Application documents"}
      description={selected ? `${selected.name} · ${selected.type}${selected.stage ? ` · ${selected.stage}` : ""}` : "Choose an application to view its documents."}
    >
      {selected && selected.documents.length === 0
        ? <p className="muted">No documents have been uploaded for this application yet.</p>
        : <div className="document-list">{(selected?.documents || []).map((document) => {
          const status = document.status || "UNKNOWN";
          const verification = document.verification || "pending";
          return <article className="document-row" key={document._id}>
            <span className="file-icon"><FileText size={18} /></span>
            <div className="document-name">
              <strong>{document.doc_type_final || document.doc_type_slot || document.original_name || "Document"}</strong>
              <small>{document.original_name || "Filename unavailable"}</small>
            </div>
            <div className="verification-statuses">
              <span><small className="muted">Document status</small><Badge variant={documentStatusVariant(status)}>{status.replaceAll("_", " ")}</Badge></span>
              <span><small className="muted">Verification</small><Badge variant={verification === "verified" ? "success" : verification === "not_verified" ? "danger" : "warning"}>{verification.replaceAll("_", " ")}</Badge></span>
            </div>
            <a className="button button-secondary button-small" href={caseWorkflowApi.getDocumentDownloadUrl(document._id)}><Download size={14} /> Download</a>
          </article>;
        })}</div>}
    </Card>
  </div>;
}
