import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Download, FileText } from "lucide-react";
import { Badge, Card } from "../components/ui/primitives";
import { caseWorkflowApi } from "../services/caseWorkflow";

function displayDate(value) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not available" : date.toLocaleDateString();
}

function documentLabel(document) {
  return document.doc_type_final || document.doc_type_slot || document.original_name;
}

export default function DocumentsLive({ title = "Documents and validity", allowNewApplication = true }) {
  const [documents, setDocuments] = useState(null);
  const [error, setError] = useState("");

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
      setError(loadError.message || "Documents could not be loaded.");
      setDocuments([]);
    }
  }, []);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  if (documents === null) {
    return <Card title="Documents and validity"><div className="loading-state" aria-label="Loading documents"><i /><i /><i /></div></Card>;
  }

  return <Card
    title={title}
    description="Uploaded documents linked to cases and applications in your authorized account scope."
    action={allowNewApplication ? <Link className="button button-primary" to="/applications/new">New application</Link> : null}
  >
    {error
      ? <div className="note warning-note" role="alert">{error}<button className="text-link" onClick={loadDocuments}>Retry</button></div>
      : documents.length === 0
        ? <div className="state-card"><FileText size={22} /><h3>No documents found</h3><p>Documents uploaded to cases and applications in your authorized scope will appear here.</p>{allowNewApplication && <Link className="button button-primary" to="/applications/new">Start an application</Link>}</div>
        : <div className="document-list">
        {documents.map((document) => {
          const fields = document.extraction?.fields || [];
          const validTo = document.lease?.lease_end
            || fields.find((field) => /valid|expir|lease.?end/i.test(field.field_name))?.confirmed_value
            || fields.find((field) => /valid|expir|lease.?end/i.test(field.field_name))?.ai_value;
          const applicationReference = document.application?.application_number
            || document.case?.caseNo
            || document.application?._id
            || document.case?._id;
          return <article className="document-row" key={document._id}>
            <span className="file-icon"><FileText size={18} /></span>
            <div className="document-name">
              <strong>{documentLabel(document)}</strong>
              <small>{document.original_name}</small>
              <small className="mono">{applicationReference ? `Application ${applicationReference}` : "Application reference unavailable"}</small>
            </div>
            <div><small className="muted">Valid to</small><strong>{displayDate(validTo)}</strong></div>
            <Badge variant={document.status === "CONFIRMED" ? "success" : document.status === "AI_FAILED" || document.status === "REJECTED" ? "danger" : "warning"}>{String(document.status || "UNKNOWN").replaceAll("_", " ")}</Badge>
            <a className="button button-secondary button-small" href={caseWorkflowApi.getDocumentDownloadUrl(document._id)}><Download size={14} /> Download</a>
          </article>;
        })}
      </div>}
  </Card>;
}
