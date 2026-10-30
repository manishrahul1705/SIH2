import { useState } from "react";

const categories = [
  "Critical Infrastructure Deficiency",
  "Land/Lease Title Dispute",
  "Safety Violation / Expired NOC",
  "Non-Compliance with APH Norms",
  "Fraudulent Documentation",
];

export default function RejectEvcModal({ busy = false, onClose, onReject }) {
  const [category, setCategory] = useState(categories[0]);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    if (reason.trim().length < 30) {
      setError("Enter at least 30 characters explaining the rejection.");
      return;
    }
    if (!confirmed) {
      setError("Confirm that the institution and previous stage officers will be notified.");
      return;
    }
    setError("");
    await onReject({ rejection_category: category, rejection_reason: reason.trim(), confirmed: true });
  }

  return <div className="evc-modal-backdrop" role="presentation">
    <section className="evc-modal evc-reject-modal" role="dialog" aria-modal="true" aria-labelledby="reject-evc-title">
      <header className="evc-modal-heading">
        <div><p className="eyebrow">APPLICATION DECISION</p><h2 id="reject-evc-title">Reject Application at EVC Stage</h2></div>
        <button className="button button-secondary button-small" type="button" onClick={onClose} disabled={busy}>Close</button>
      </header>
      <form className="evc-form" onSubmit={submit}>
        <label className="field-label">Rejection category
          <select value={category} onChange={(event) => setCategory(event.target.value)} disabled={busy}>
            {categories.map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>
        <label className="field-label">Mandatory rejection remarks
          <textarea rows={6} maxLength={3000} value={reason} onChange={(event) => setReason(event.target.value)} aria-describedby="evc-rejection-counter" required disabled={busy} />
          <small id="evc-rejection-counter" className={reason.trim().length < 30 ? "evc-char-count insufficient" : "evc-char-count"}>{reason.trim().length} / 30 min characters</small>
        </label>
        <label className="evc-confirmation">
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={busy} />
          <span>I confirm that this rejection will notify the institution and all previous stage officers.</span>
        </label>
        {error && <p className="alert alert-warning" role="alert">{error}</p>}
        <footer className="evc-modal-actions">
          <button className="button button-secondary" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="button button-danger" type="submit" disabled={busy || reason.trim().length < 30 || !confirmed}>{busy ? "Rejecting…" : "Confirm rejection"}</button>
        </footer>
      </form>
    </section>
  </div>;
}
