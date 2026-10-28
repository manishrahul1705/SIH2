import { AlertTriangle, CheckCircle2, Info } from "lucide-react";

export function PageHeader({ eyebrow, title, description, action }) {
  return <div className="stakeholder-page-heading">
    <div><p className="stakeholder-eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>
    {action && <div className="stakeholder-heading-action">{action}</div>}
  </div>;
}

export function Panel({ title, description, action, children, className = "" }) {
  return <section className={`stakeholder-panel ${className}`}>
    {(title || action) && <div className="stakeholder-panel-heading"><div>{title && <h2>{title}</h2>}{description && <p>{description}</p>}</div>{action}</div>}
    {children}
  </section>;
}

export function StatusPill({ children, tone = "green" }) {
  return <span className={`stakeholder-pill tone-${tone}`}>{tone === "green" ? <CheckCircle2 size={14} /> : tone === "amber" ? <AlertTriangle size={14} /> : <Info size={14} />}{children}</span>;
}

export function SafeguardNote({ children, tone = "blue" }) {
  return <div className={`stakeholder-note note-${tone}`}><Info size={17} /><span>{children}</span></div>;
}

export function Metric({ label, value, note, icon: Icon }) {
  return <div className="stakeholder-metric">
    <div className="stakeholder-metric-top"><span>{label}</span>{Icon && <Icon size={18} />}</div>
    <strong>{value}</strong>{note && <small>{note}</small>}
  </div>;
}

export function EmptyState({ title, detail }) {
  return <div className="stakeholder-empty"><strong>{title}</strong><p>{detail}</p></div>;
}

export function formatINR(value) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);
}
