import { useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Bell, ChevronDown, CircleHelp, Menu, Search, Shield, ShieldCheck } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { authApi } from "../services/auth";

const navigation = {
  "Institution user": [
    ["Dashboard", "/dashboard"], ["New application", "/applications/new"], ["My cases", "/cases"], ["Documents and validity", "/documents"], ["Undertakings", "/undertakings"], ["Deficiency responses", "/deficiencies"], ["Notifications", "/notifications"],
  ],
  "Scrutiny / Regional officer": [
    ["My queue", "/queue"], ["Cases", "/cases"], ["Verification", "/verification"], ["Notifications", "/notifications"], ["Audit trail", "/audit"],
  ],
  "EVC member": [["EVC queue", "/evc"], ["My visits", "/evc/visits"], ["Notifications", "/notifications"]],
  "SAC/SHC member": [["Hearings and appeals", "/hearings"], ["Notifications", "/notifications"]],
  "Competent authority": [["Decisions", "/decisions"], ["Region dashboard", "/region"], ["Reports", "/reports"], ["Audit trail", "/audit"]],
  "Senior authority": [["Region dashboard", "/region"], ["Reports", "/reports"], ["Escalations", "/escalations"], ["Audit trail", "/audit"]],
  Admin: [["Policy and stages", "/policy"], ["Alert rules", "/alert-rules"], ["Users and roles", "/users"], ["AI service", "/ai-service"], ["Audit trail", "/audit"]],
};

const roleHome = {
  "Institution user": "/dashboard",
  "Scrutiny / Regional officer": "/queue",
  "EVC member": "/evc",
  "SAC/SHC member": "/hearings",
  "Competent authority": "/decisions",
  "Senior authority": "/region",
  Admin: "/policy",
  Student: "/student/college-overview",
  Faculty: "/faculty/college-overview",
};

const pageNames = {
  "/dashboard": "Dashboard", "/applications/new": "New application", "/cases": "My cases", "/documents": "Documents and validity", "/document-review": "Document upload and AI review",
  "/undertakings": "Undertakings", "/deficiencies": "Deficiency responses", "/notifications": "Notifications", "/audit": "Audit trail",
  "/queue": "My queue", "/verification": "Verification", "/evc": "EVC queue and scheduling", "/evc/visits": "My EVC visits", "/hearings": "Hearings and appeals",
  "/decisions": "Decisions", "/region": "Region dashboard", "/reports": "Reports", "/policy": "Policy and stages",
  "/alert-rules": "Alert rules", "/users": "Users and roles", "/ai-service": "AI service",
  "/case/AT-2026-0040": "Case detail", "/case/AT-2026-0038": "Case detail",
};

export { navigation, pageNames, roleHome };

export default function AppShell({ children }) {
  const [rail, setRail] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const role = useAppStore((state) => state.role);
  const user = useAppStore((state) => state.user);
  const unreadCount = useAppStore((state) => state.notifications.filter((item) => !item.acknowledged).length);
  const clearAuthenticatedUser = useAppStore((state) => state.clearAuthenticatedUser);
  const navigate = useNavigate();
  const location = useLocation();
  const links = navigation[role] || [];
  const currentPage = pageNames[location.pathname] || "Workspace";

  async function signOut() {
    try {
      await authApi.logout();
    } finally {
      clearAuthenticatedUser();
      navigate("/login", { replace: true });
    }
  }

  return <div className="app-shell">
    <div className="government-strip"><Link to="/">AICTE <span>|</span> ApprovalTrack</Link><div><Link to="/student/college-overview">Student portal</Link><Link to="/faculty/college-overview">Faculty portal</Link><a href="mailto:support@example.gov.in"><CircleHelp size={14} /> Help</a><button aria-label="Language">EN <ChevronDown size={12} /></button></div></div>
    <div className="saffron-rule" />
    <header className="top-bar">
      <button className="mobile-nav-toggle" onClick={() => setDrawer(!drawer)} aria-label="Toggle navigation"><Menu size={19} /></button>
      <div className="breadcrumb"><Link to={roleHome[role]}>Workspace</Link><span>/</span><strong>{currentPage}</strong></div>
      <label className="global-search"><Search size={16} /><input aria-label="Global search" placeholder="Search cases, institutions, documents…" /><kbd>Ctrl K</kbd></label>
      <div className="top-actions"><Link className="notification-link" to="/notifications" aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ""}`}><Bell size={18} />{unreadCount > 0 && <span>{unreadCount}</span>}</Link><span className="role-chip">{role}</span><DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="user-menu"><span className="user-avatar">{user?.name?.slice(0, 1).toUpperCase() || "U"}</span><span className="user-menu-name">{user?.name || user?.email || "Account"}</span><ChevronDown size={15} /></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="role-menu" align="end" sideOffset={8}><strong>{user?.email || role}</strong><DropdownMenu.Item className="role-option" onSelect={signOut}>Sign out</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root></div>
    </header>
    <div className="workspace-layout">
      <button className={`sidebar-scrim ${drawer ? "visible" : ""}`} aria-label="Close navigation" onClick={() => setDrawer(false)} />
      <aside className={`sidebar ${rail ? "sidebar-rail" : ""} ${drawer ? "sidebar-drawer" : ""}`}><div className="sidebar-header"><div className="agency-emblem"><ShieldCheck size={20} /></div>{!rail && <div><strong>AICTE</strong><small>ApprovalTrack</small></div>}</div><div className="nav-caption">{!rail && "WORKSPACE"}</div><nav aria-label="Role navigation">{links.map(([label, path]) => {const isActive = location.pathname === path || (path === "/cases" && location.pathname.startsWith("/case/"));return <NavLink end onClick={() => setDrawer(false)} title={rail ? label : undefined} className={`side-link ${isActive ? "active" : ""}`} to={path} key={`${role}-${label}`}><span className="nav-icon"><NavIcon label={label} /></span>{!rail && <span>{label}</span>}{!rail && label === "Notifications" && <i className="nav-count">3</i>}</NavLink>;})}</nav><div className="sidebar-bottom"><div className="policy-compact"><Shield size={15} />{!rail && <span>Policy v2026.2<br /><small>Signed off · 01 Aug 2026</small></span>}</div><button className="collapse-rail" onClick={() => setRail(!rail)}>{rail ? "›" : "‹"}{!rail && " Collapse sidebar"}</button></div></aside>
      <main className="main-column"><div className="page-container">{children}<footer className="site-footer"><span>ApprovalTrack</span><span>Institutional workflow management</span></footer></div></main>
    </div>
  </div>;
}

function NavIcon({ label }) {
  const { LayoutDashboard, FilePlus2, Files, FileCheck2, ClipboardList, MessageSquareWarning, Inbox, SearchCheck, History, CalendarDays, Gavel, Map, BarChart3, Flag, Settings2, Bell, Users, Bot, FileText, Scale } = requireIcons;
  const map = {
    Dashboard: LayoutDashboard, "New application": FilePlus2, "My cases": Files, "Documents and validity": FileCheck2,
    Undertakings: ClipboardList, "Deficiency responses": MessageSquareWarning, Notifications: Bell, "My queue": Inbox, Cases: Files,
    Verification: SearchCheck, "Audit trail": History, "EVC queue": CalendarDays, "My visits": CalendarDays,
    "Hearings and appeals": Gavel, Decisions: Scale, "Region dashboard": Map, Reports: BarChart3, Escalations: Flag,
    "Policy and stages": Settings2, "Alert rules": Bell, "Users and roles": Users, "AI service": Bot,
  };
  const Icon = map[label] || FileText;
  return <Icon size={18} strokeWidth={1.75} />;
}

import * as requireIcons from "lucide-react";
