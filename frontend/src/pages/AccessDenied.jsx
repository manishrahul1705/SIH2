import { Link } from "react-router-dom";
import { ArrowLeft, ShieldX } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { roleHome } from "../layouts/AppShell";

export function AccessDenied({ notFound = false }) {
  const role = useAppStore((state) => state.role);
  return <section className="access-denied"><div className="access-icon"><ShieldX size={28} /></div><p className="eyebrow">WORKSPACE ACCESS</p><h1>{notFound ? "Page not found" : "Access denied"}</h1><p>{notFound ? "This route is not available in the demo workspace." : `The ${role} role does not have permission to view this page. The denied attempt has been recorded in the audit trail.`}</p><Link className="button button-primary" to={roleHome[role]}><ArrowLeft size={16} /> Return to your workspace</Link></section>;
}
