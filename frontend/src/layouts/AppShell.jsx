import { useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, CircleHelp, Menu, Search, Shield, ShieldCheck } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { authApi } from "../services/auth";
import AlertsDrawer from "../components/AlertsDrawer";

const navigation = {
  "Institution user": [
    ["Dashboard", "/dashboard"], ["New application", "/applications/new"], ["My cases", "/cases"], ["Assist requests", "/assist-requests"], ["Documents and validity", "/documents"], ["Undertakings", "/undertakings"], ["Institution IC annual report", "/institution-annual-report"], ["College grievances", "/institution/complaints"], ["Deficiency responses", "/deficiencies"], ["Notifications", "/notifications"],
  ],
  Student: [
    ["College Overview & Approval", "/student/college-overview"], ["Approved Courses & Offerings", "/student/offerings"], ["Campus Facilities & Safety", "/student/facilities"], ["AICTE Announcements", "/student/announcements"], ["Lodge a Complaint", "/student/complaints/new"], ["My Complaints & Tracker", "/student/complaints"], ["Statutory Committees & Help", "/student/committees"],
  ],
  Faculty: [
    ["College Overview & Offerings", "/faculty/college-overview"], ["Department & Cadre Roster", "/faculty/department-roster"], ["AICTE Announcements", "/faculty/announcements"], ["Submit Yearly Report", "/faculty/yearly-report/new"], ["My Yearly Reports History", "/faculty/yearly-reports"], ["Lodge a Complaint", "/faculty/complaints/new"], ["My Complaints & Tracker", "/faculty/complaints"],
  ],
  "Scrutiny / Regional officer": [
    ["My queue", "/queue"], ["Cases", "/cases"], ["Assist requests", "/assist-requests"], ["Verification", "/verification"], ["Notifications", "/notifications"],
  ],
  "EVC member": [["Dashboard", "/dashboard"], ["Cases", "/cases"], ["My visits", "/evc/visits"], ["Assist requests", "/assist-requests"], ["Notifications", "/notifications"]],
  "EVC chairman": [["Dashboard", "/dashboard"], ["Cases", "/cases"], ["My visits", "/evc/visits"], ["Assist requests", "/assist-requests"], ["Notifications", "/notifications"]],
  "SAC/SHC member": [["Hearings and appeals", "/hearings"], ["Cases", "/cases"], ["Assist requests", "/assist-requests"], ["Notifications", "/notifications"]],
  "Competent authority": [["Final approval queue", "/bureau/approvals"], ["Cases", "/cases"], ["Assist requests", "/assist-requests"], ["Region dashboard", "/region"], ["Reports", "/reports"]],
  "Senior authority": [["Region dashboard", "/region"], ["Reports", "/reports"], ["Escalations", "/escalations"]],
  Admin: [["Legacy decisions", "/decisions"], ["Legacy monitoring", "/admin/incidents"], ["College grievances", "/admin/grievances"], ["Policy and stages", "/policy"], ["Assist requests", "/assist-requests"], ["Notifications", "/notifications"], ["Alert rules", "/alert-rules"], ["Announcements & complaints", "/governance"], ["Users and roles", "/users"], ["AI service", "/ai-service"], ["Audit trail", "/audit"]],
  "Grievance officer": [["Institution grievance queue", "/grievances"]],
  Ombudsperson: [["Student appeals", "/grievances"]],
  "University/DTE Officer": [["Faculty/staff appeals", "/grievances"]],
};

const roleHome = {
  "Institution user": "/dashboard",
  "Scrutiny / Regional officer": "/queue",
  "EVC member": "/dashboard",
  "EVC chairman": "/dashboard",
  "SAC/SHC member": "/hearings",
  "Competent authority": "/bureau/approvals",
  "Senior authority": "/region",
  Admin: "/audit",
  Student: "/student/college-overview",
  Faculty: "/faculty/college-overview",
  "Grievance officer": "/grievances",
  Ombudsperson: "/grievances",
  "University/DTE Officer": "/grievances",
};

const pageNames = {
  "/dashboard": "Dashboard", "/applications/new": "New application", "/cases": "My cases", "/documents": "Documents and validity", "/document-review": "Document upload and AI review",
  "/student/college-overview": "College Overview & Approval", "/student/offerings": "Approved Courses & Offerings", "/student/facilities": "Campus Facilities & Safety", "/student/announcements": "AICTE Announcements", "/student/complaints/new": "Lodge a Complaint", "/student/complaints": "My Complaints & Tracker", "/student/committees": "Statutory Committees & Help",
  "/faculty/college-overview": "College Overview & Offerings", "/faculty/department-roster": "Department & Cadre Roster", "/faculty/announcements": "AICTE Announcements", "/faculty/yearly-report/new": "Submit Yearly Report", "/faculty/yearly-reports": "My Yearly Reports History", "/faculty/complaints/new": "Lodge a Complaint", "/faculty/complaints": "My Complaints & Tracker",
  "/undertakings": "Undertakings", "/deficiencies": "Deficiency responses", "/notifications": "Notifications", "/audit": "Audit trail",
  "/queue": "My queue", "/verification": "Verification", "/evc": "EVC queue and scheduling", "/evc/cases": "EVC stage workspace", "/evc/visits": "My Visits", "/hearings": "Hearings and appeals",
  "/decisions": "Decisions", "/admin/incidents": "Legacy Application Monitoring", "/region": "Region dashboard", "/reports": "Reports", "/policy": "Policy and stages",
  "/escalations": "Escalations",
  "/governance": "Announcements and complaints",
  "/institution-annual-report": "Institution IC annual report",
  "/institution/complaints": "College grievances",
  "/admin/grievances": "College grievances",
  "/portal/my-complaints": "My Complaints & Tracker",
  "/grievances": "Grievance and appeals queue",
  "/assist-requests": "Stage assist requests",
  "/bureau/approvals": "Bureau Officer final approval queue",
  "/alert-rules": "Alert rules", "/users": "Users and roles", "/ai-service": "AI service",
  "/case/AT-2026-0040": "Case detail", "/case/AT-2026-0038": "Case detail",
};

export { navigation, pageNames, roleHome };

export default function AppShell({ children }) {
  const [rail, setRail] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const role = useAppStore((state) => state.role);
  const user = useAppStore((state) => state.user);
  const clearAuthenticatedUser = useAppStore((state) => state.clearAuthenticatedUser);
  const navigate = useNavigate();
  const location = useLocation();
  const links = navigation[role] || [];
  const currentPage = role === "EVC member" || role === "EVC chairman"
    ? location.pathname.startsWith("/cases") ? "Cases" : pageNames[location.pathname] || "Workspace"
    : /^\/documents\/[^/]+$/.test(location.pathname) ? "Application documents" : pageNames[location.pathname] || "Workspace";
  const isCaseDetail = /^\/case\/[^/]+$/.test(location.pathname);
  const isDocumentDetail = /^\/documents\/[^/]+$/.test(location.pathname);

  async function signOut() {
    try {
      await authApi.logout();
    } finally {
      clearAuthenticatedUser();
      navigate("/login", { replace: true });
    }
  }

  return <div className="app-shell">
    <div className="government-strip"><Link to="/">AICTE <span>|</span> ApprovalTrack</Link><div><a href="mailto:support@example.gov.in"><CircleHelp size={14} /> Help</a><button aria-label="Language">EN <ChevronDown size={12} /></button></div></div>
    <div className="saffron-rule" />
    <header className="top-bar">
      <button className="mobile-nav-toggle" onClick={() => setDrawer(!drawer)} aria-label="Toggle navigation"><Menu size={19} /></button>
      <div className="breadcrumb">{isCaseDetail
        ? <><Link to="/cases">My cases</Link><span>/</span><strong>Case detail</strong></>
        : isDocumentDetail
          ? <><Link to="/documents">Documents and validity</Link><span>/</span><strong>{location.state?.applicationId || "Application documents"}</strong></>
        : <><Link to={roleHome[role]}>Workspace</Link><span>/</span><strong>{currentPage}</strong></>}</div>
      <label className="global-search"><Search size={16} /><input aria-label="Global search" placeholder="Search cases, institutions, documents…" /><kbd>Ctrl K</kbd></label>
      <div className="top-actions">{role !== "Student" && role !== "Faculty" && <AlertsDrawer />}<span className="role-chip">{role}</span><DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="user-menu"><span className="user-avatar">{user?.name?.slice(0, 1).toUpperCase() || "U"}</span><span className="user-menu-name">{user?.name || user?.email || "Account"}</span><ChevronDown size={15} /></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="role-menu" align="end" sideOffset={8}><strong>{user?.email || role}</strong><DropdownMenu.Item className="role-option" onSelect={signOut}>Sign out</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root></div>
    </header>
    <div className="workspace-layout">
      <button className={`sidebar-scrim ${drawer ? "visible" : ""}`} aria-label="Close navigation" onClick={() => setDrawer(false)} />
      <aside className={`sidebar ${rail ? "sidebar-rail" : ""} ${drawer ? "sidebar-drawer" : ""}`}><div className="sidebar-header"><div className="agency-emblem"><ShieldCheck size={20} /></div>{!rail && <div><strong>AICTE</strong><small>ApprovalTrack</small></div>}</div><div className="nav-caption">{!rail && "WORKSPACE"}</div><nav aria-label="Role navigation">{links.map(([label, path]) => {const isActive = location.pathname === path || (path === "/documents" && location.pathname.startsWith("/documents/")) || (path === "/cases" && (location.pathname.startsWith("/case/") || location.pathname.startsWith("/cases/")));return <NavLink end onClick={() => setDrawer(false)} title={rail ? label : undefined} className={`side-link ${isActive ? "active" : ""}`} to={path} key={`${role}-${label}`}><span className="nav-icon"><NavIcon label={label} /></span>{!rail && <span>{label}</span>}</NavLink>;})}</nav><div className="sidebar-bottom"><div className="policy-compact"><Shield size={15} />{!rail && <span>Policy status<br /><small>Managed by backend</small></span>}</div><button className="collapse-rail" onClick={() => setRail(!rail)}>{rail ? "›" : "‹"}{!rail && " Collapse sidebar"}</button></div></aside>
      <main className="main-column"><div className="page-container">{children}<footer className="site-footer"><span>ApprovalTrack</span><span>Institutional workflow management</span></footer></div></main>
    </div>
  </div>;
}

function NavIcon({ label }) {
  const { LayoutDashboard, FilePlus2, Files, FileCheck2, ClipboardList, MessageSquareWarning, Inbox, SearchCheck, History, CalendarDays, Gavel, Map, BarChart3, Flag, Settings2, Bell, Users, Bot, FileText, Scale } = requireIcons;
  const map = {
    Dashboard: LayoutDashboard, "New application": FilePlus2, "My cases": Files, "Documents and validity": FileCheck2,
    "College Overview & Approval": requireIcons.Building2, "College Overview & Offerings": requireIcons.Building2, "Approved Courses & Offerings": requireIcons.BookOpen, "Campus Facilities & Safety": requireIcons.ShieldCheck, "AICTE Announcements": Bell, "Lodge a Complaint": FilePlus2, "My Complaints & Tracker": MessageSquareWarning, "Statutory Committees & Help": Users, "Department & Cadre Roster": Users, "Submit Yearly Report": FileCheck2, "My Yearly Reports History": ClipboardList,
    Undertakings: ClipboardList, "Deficiency responses": MessageSquareWarning, Notifications: Bell, "My queue": Inbox, Cases: Files, "College grievances": MessageSquareWarning,
    Verification: SearchCheck, "Audit trail": History, "EVC queue": CalendarDays, "My visits": CalendarDays,
    "Hearings and appeals": Gavel, Decisions: Scale, "Legacy decisions": Scale, "Legacy monitoring": requireIcons.AlertTriangle, "Final approval queue": Scale, "Region dashboard": Map, Reports: BarChart3, Escalations: Flag,
    "Policy and stages": Settings2, "Alert rules": Bell, "Users and roles": Users, "AI service": Bot,
  };
  const Icon = map[label] || FileText;
  return <Icon size={18} strokeWidth={1.75} />;
}

import * as requireIcons from "lucide-react";
