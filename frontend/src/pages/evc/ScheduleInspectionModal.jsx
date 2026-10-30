import { useState } from "react";

function tomorrowDate() {
  return new Date(Date.now() + 86400000).toISOString().split("T")[0];
}

function dateInputValue(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

export default function ScheduleInspectionModal({
  panelists = [],
  busy = false,
  initialSchedule,
  onClose,
  onSchedule,
}) {
  const [date, setDate] = useState(() => dateInputValue(initialSchedule?.scheduled_inspection_date));
  const [mode, setMode] = useState(() => initialSchedule?.inspection_mode || "PHYSICAL");
  const [instructions, setInstructions] = useState(() => initialSchedule?.inspection_instructions || "");
  const [error, setError] = useState("");
  const minimumDate = tomorrowDate();
  const editing = Boolean(initialSchedule);

  async function submit(event) {
    event.preventDefault();
    if (!date || date < minimumDate) {
      setError("Select an inspection date starting tomorrow or later.");
      return;
    }
    setError("");
    await onSchedule({ scheduled_inspection_date: date, inspection_mode: mode, instructions });
  }

  return <div className="evc-modal-backdrop" role="presentation">
    <section className="evc-modal" role="dialog" aria-modal="true" aria-labelledby="schedule-evc-title">
      <header className="evc-modal-heading">
        <div><p className="eyebrow">EXPERT VISIT COMMITTEE</p><h2 id="schedule-evc-title">{editing ? "Edit scheduled EVC inspection" : "Schedule Expert Visit Committee (EVC) Inspection"}</h2></div>
        <button className="button button-secondary button-small" type="button" onClick={onClose} disabled={busy}>Close</button>
      </header>
      <form className="evc-form" onSubmit={submit}>
        <label className="field-label">Inspection mode
          <select value={mode} onChange={(event) => setMode(event.target.value)} disabled={busy}>
            <option value="PHYSICAL">Physical Campus Visit</option>
            <option value="VIRTUAL">Virtual Inspection</option>
            <option value="HYBRID">Virtual / Hybrid Inspection</option>
          </select>
        </label>
        <label className="field-label">Inspection date
          <input type="date" min={minimumDate} value={date} onChange={(event) => setDate(event.target.value)} onBlur={() => {
            if (date && date < minimumDate) setError("Today and past dates are not available.");
          }} required disabled={busy} />
          <small>Inspections can be scheduled from {minimumDate} onward.</small>
        </label>
        <fieldset className="evc-panelists"><legend>Assigned committee members / panelists</legend>
          {panelists.length
            ? panelists.map((member) => <span key={member._id}>{member.name}{member.email ? ` · ${member.email}` : ""}</span>)
            : <span>Assigned EVC panel</span>}
        </fieldset>
        <label className="field-label">Special instructions / focus areas
          <textarea maxLength={3000} rows={4} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="For example: Keep original fire NOC and land records ready in the Principal's office." disabled={busy} />
        </label>
        {error && <p className="alert alert-warning" role="alert">{error}</p>}
        <footer className="evc-modal-actions">
          <button className="button button-secondary" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="button button-primary" type="submit" disabled={busy}>{busy ? editing ? "Saving…" : "Scheduling…" : editing ? "Save schedule" : "Schedule inspection"}</button>
        </footer>
      </form>
    </section>
  </div>;
}
