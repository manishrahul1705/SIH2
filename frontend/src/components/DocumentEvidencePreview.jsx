import { useEffect, useRef, useState } from "react";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { caseWorkflowApi } from "../services/caseWorkflow";

function normalizedBox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  const [x0, y0, x1, y1] = bbox.map(Number);
  if (![x0, y0, x1, y1].every(Number.isFinite) || x0 < 0 || y0 < 0 || x1 > 1 || y1 > 1 || x1 <= x0 || y1 <= y0) return null;
  return { left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` };
}

export default function DocumentEvidencePreview({ documentId, fileName, page = 1, bbox, confidence, onClose, showSourceDetails = true }) {
  const canvasRef = useRef(null);
  const [imageUrl, setImageUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const box = normalizedBox(bbox);
  const confidenceValue = confidence === null || confidence === undefined || confidence === "" ? Number.NaN : Number(confidence);
  const confidenceClass = Number.isFinite(confidenceValue)
    ? confidenceValue >= 0.9 ? "high" : confidenceValue >= 0.7 ? "medium" : "low"
    : "unknown";

  useEffect(() => {
    let disposed = false;
    let objectUrl = "";
    let loadingTask;
    let renderTask;

    async function renderEvidence() {
      try {
        setLoading(true);
        setError("");
        const blob = await caseWorkflowApi.downloadDocument(documentId);
        if (disposed) return;
        if (blob.type === "image/jpeg" || blob.type === "image/png") {
          objectUrl = URL.createObjectURL(blob);
          setImageUrl(objectUrl);
          return;
        }
        if (blob.type !== "application/pdf") throw new Error("Preview is available for PDF, JPEG, and PNG documents.");
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        loadingTask = pdfjs.getDocument({ data: await blob.arrayBuffer() });
        const pdf = await loadingTask.promise;
        const pageNumber = Math.max(1, Math.min(Number(page) || 1, pdf.numPages));
        const pdfPage = await pdf.getPage(pageNumber);
        const viewport = pdfPage.getViewport({ scale: 1.5 });
        const canvas = canvasRef.current;
        if (!canvas || disposed) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        renderTask = pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport });
        await renderTask.promise;
      } catch (previewError) {
        if (!disposed) setError(previewError.message || "The evidence preview could not be loaded.");
      } finally {
        if (!disposed) setLoading(false);
      }
    }

    renderEvidence();
    return () => {
      disposed = true;
      renderTask?.cancel();
      loadingTask?.destroy();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [documentId, page]);

  return <section className="document-evidence-preview" aria-label={`${showSourceDetails ? "Source" : "Document"} preview for ${fileName}`}>
    <div className="document-evidence-preview-heading">
      <strong>{showSourceDetails ? `Source highlight · page ${page || 1}${Number.isFinite(confidenceValue) ? ` · ${Math.round(confidenceValue * 100)}% confidence` : ""}` : "Document preview"}</strong>
      {onClose && <button className="button button-secondary button-small" type="button" onClick={onClose}>Close preview</button>}
    </div>
    {loading && <p className="muted" role="status">Loading protected document preview…</p>}
    {error && <p className="alert alert-warning" role="alert">{error}</p>}
    {!error && <div className="document-evidence-page">
      {imageUrl
        ? <img src={imageUrl} alt={`${fileName}, page ${page || 1}`} />
        : <canvas ref={canvasRef} aria-label={`${fileName}, page ${page || 1}`} />}
      {box && <span className={`document-evidence-box confidence-${confidenceClass}`} style={box} aria-label={`Extracted source bounding box, ${confidenceClass} confidence`} />}
    </div>}
    {showSourceDetails && !box && <p className="muted">The extraction did not include a valid page bounding box.</p>}
  </section>;
}
