import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Download, FileQuestion, FileText, Image, LoaderCircle, X } from "lucide-react";
import { caseWorkflowApi } from "../services/caseWorkflow";

function documentKind(mimeType, fileName) {
  if (mimeType === "application/pdf" || /\.pdf$/i.test(fileName)) return "pdf";
  if (mimeType === "image/jpeg" || mimeType === "image/png" || /\.(jpe?g|png)$/i.test(fileName)) return "image";
  return "unsupported";
}

export default function DocumentPreviewDialog({ document, onClose }) {
  const [source, setSource] = useState("");
  const [mimeType, setMimeType] = useState(document?.mimeType || "");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const fileName = document?.fileName || "Application document";

  useEffect(() => {
    let active = true;
    let objectUrl = "";

    async function loadDocument() {
      setLoading(true);
      setError("");
      setSource("");
      try {
        const blob = document.file || await caseWorkflowApi.downloadDocument(document.documentId);
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
        setMimeType(blob.type || document.mimeType || "");
      } catch (previewError) {
        if (active) setError(previewError.message || "The document preview could not be loaded.");
      } finally {
        if (active) setLoading(false);
      }
    }

    loadDocument();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [document]);

  const kind = documentKind(mimeType, fileName);

  return <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="document-preview-overlay" />
      <Dialog.Content className="document-preview-dialog">
        <header className="document-preview-header">
          <span className="document-preview-icon">{kind === "image" ? <Image size={20} /> : kind === "unsupported" ? <FileQuestion size={20} /> : <FileText size={20} />}</span>
          <div className="document-preview-title">
            <Dialog.Title>{fileName}</Dialog.Title>
            <Dialog.Description>{mimeType || "Document preview"}</Dialog.Description>
          </div>
          {source && <a className="button button-secondary button-small document-preview-download" href={source} download={fileName}><Download size={14} /> Download</a>}
          <Dialog.Close className="document-preview-close" aria-label="Close document preview"><X size={19} /></Dialog.Close>
        </header>
        <div className="document-preview-body">
          {loading && <div className="document-preview-state" role="status"><LoaderCircle size={25} className="document-preview-spinner" /><strong>Loading document…</strong><span>Securely retrieving the selected application file.</span></div>}
          {!loading && error && <div className="document-preview-state document-preview-error" role="alert"><FileQuestion size={28} /><strong>Preview unavailable</strong><span>{error}</span></div>}
          {!loading && !error && kind === "pdf" && source && <iframe className="document-preview-frame" src={`${source}#toolbar=1&navpanes=0`} title={`PDF preview: ${fileName}`} />}
          {!loading && !error && kind === "image" && source && <div className="document-preview-image-wrap"><img src={source} alt={`Preview of ${fileName}`} /></div>}
          {!loading && !error && kind === "unsupported" && <div className="document-preview-state"><FileQuestion size={30} /><strong>Inline preview is not available</strong><span>{fileName} · {mimeType || "Unknown file type"}</span><span>This file type cannot be displayed in the browser preview.</span></div>}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
