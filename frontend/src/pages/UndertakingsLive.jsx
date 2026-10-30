import { ClipboardCheck, Clock3, Download, FileCheck2, Search, TriangleAlert } from "lucide-react";

function daysUntil(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : Math.ceil((date.getTime() - Date.now()) / 86400000);
}

function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not available" : date.toLocaleDateString();
}

export default function UndertakingsLive({ data }) {
  const items = Array.isArray(data?.undertakings) ? data.undertakings : [];
  const open = items.filter((item) => item.status !== "SUBMITTED");
  const dueSoon = open.filter((item) => {
    const remaining = daysUntil(item.dueDate);
    return remaining !== null && remaining >= 0 && remaining <= 7;
  });
  const overdue = items.filter((item) => item.status === "OVERDUE" || daysUntil(item.dueDate) < 0);
  const submitted = items.filter((item) => item.status === "SUBMITTED");

  return (
    <div className="undertakings-page">
      <div className="undertakings-page-header">
        <div>
          <p className="undertakings-eyebrow">OBLIGATION REGISTER</p>
          <h1>Undertakings</h1>
          <p className="undertakings-subtitle">Review actual undertaking records and due dates.</p>
        </div>
      </div>

      <div className="undertakings-summary-grid">
        <div className="undertaking-stat-card tone-blue">
          <div className="stat-icon-wrap"><ClipboardCheck size={20} /></div>
          <div className="stat-copy">
            <span>Open</span>
            <strong>{open.length}</strong>
          </div>
        </div>
        <div className="undertaking-stat-card tone-amber">
          <div className="stat-icon-wrap"><Clock3 size={20} /></div>
          <div className="stat-copy">
            <span>Due within 7 days</span>
            <strong>{dueSoon.length}</strong>
          </div>
        </div>
        <div className="undertaking-stat-card tone-red">
          <div className="stat-icon-wrap"><TriangleAlert size={20} /></div>
          <div className="stat-copy">
            <span>Overdue</span>
            <strong>{overdue.length}</strong>
          </div>
        </div>
        <div className="undertaking-stat-card tone-green">
          <div className="stat-icon-wrap"><FileCheck2 size={20} /></div>
          <div className="stat-copy">
            <span>Submitted</span>
            <strong>{submitted.length}</strong>
          </div>
        </div>
      </div>

      <section className="undertaking-register-card">
        <div className="undertaking-register-header">
          <div className="register-title-wrap">
            <div className="register-icon"><ClipboardCheck size={18} /></div>
            <div>
              <h2>Undertaking register</h2>
              <p>Records and statuses are retrieved from the backend.</p>
            </div>
          </div>
        </div>

        <div className="undertaking-table-toolbar">
          <label className="undertaking-search-box">
            <Search size={16} />
            <input type="text" placeholder="Search records" aria-label="Search records" />
          </label>
          <div className="undertaking-toolbar-actions">
            <button className="undertaking-export-btn" type="button"><Download size={16} /> Export CSV</button>
            <select className="undertaking-density-select" aria-label="Density">
              <option>Density</option>
              <option>Comfortable</option>
            </select>
          </div>
        </div>

        <div className="undertaking-table-shell">
          <div className="undertaking-table-head">
            <span>Undertaking</span>
            <span>Application reference</span>
            <span>Due date</span>
            <span>Status</span>
          </div>

          {items.length ? (
            <div className="undertaking-table-body">
              {items.map((item) => (
                <div className="undertaking-table-row" key={item.id || item.caseId || item.title}>
                  <span>{item.title || "Undertaking"}</span>
                  <span>{item.caseId || "—"}</span>
                  <span>{dateLabel(item.dueDate)}</span>
                  <span>
                    <span className={`undertaking-status-pill ${item.status === "SUBMITTED" ? "success" : item.status === "OVERDUE" ? "danger" : "warning"}`}>
                      {item.status || "OPEN"}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="undertaking-empty-state">
              <div className="empty-state-illustration"><ClipboardCheck size={32} /></div>
              <p>No undertakings are available in your scope.</p>
            </div>
          )}
        </div>

        <div className="undertaking-table-footer">
          <span>Page 1 of 1</span>
          <div className="undertaking-pager">
            <button type="button">Previous</button>
            <button type="button" className="pager-next">Next</button>
          </div>
        </div>
      </section>
    </div>
  );
}
