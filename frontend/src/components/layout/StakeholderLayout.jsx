import { useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  AlertTriangle, Bell, BookOpen, Building2, ClipboardList, FileCheck2, FilePlus2,
  GraduationCap, LogOut, Menu, MessageSquareWarning, ShieldCheck, Users, X,
} from "lucide-react";
import { StakeholderProvider, useStakeholder } from "../../context/StakeholderContext";
import { useAppStore } from "../../store/useAppStore";
import { authApi } from "../../services/auth";
import "../../styles/stakeholder.css";

const STUDENT_NAV = [
  { label: "College Overview & Approval", path: "/student/college-overview", icon: Building2 },
  { label: "Approved Courses & Offerings", path: "/student/offerings", icon: BookOpen },
  { label: "Campus Facilities & Safety", path: "/student/facilities", icon: ShieldCheck },
  { label: "Lodge a Complaint", path: "/student/complaints/new", icon: FilePlus2 },
  { label: "My Complaints & Tracker", path: "/student/complaints", icon: MessageSquareWarning },
  { label: "Statutory Committees & Help", path: "/student/committees", icon: Users },
];

const FACULTY_NAV = [
  { label: "College Overview & Offerings", path: "/faculty/college-overview", icon: Building2 },
  { label: "Department & Cadre Roster", path: "/faculty/department-roster", icon: Users },
  { label: "Submit Yearly Report", path: "/faculty/yearly-report/new", icon: FileCheck2 },
  { label: "My Yearly Reports History", path: "/faculty/yearly-reports", icon: ClipboardList },
  { label: "Lodge a Complaint", path: "/faculty/complaints/new", icon: FilePlus2 },
  { label: "My Complaints & Tracker", path: "/faculty/complaints", icon: MessageSquareWarning },
];

const TITLES = Object.fromEntries([...STUDENT_NAV, ...FACULTY_NAV].map(({ path, label }) => [path, label]));
function StakeholderShell() {
  const { role } = useStakeholder();
  const user = useAppStore((state) => state.user);
  const clearAuthenticatedUser = useAppStore((state) => state.clearAuthenticatedUser);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const faculty = role === "faculty";
  const links = faculty ? FACULTY_NAV : STUDENT_NAV;
  const quickPath = `/${role}/complaints/new`;
  const displayName = user?.name || user?.email || (faculty ? "Faculty member" : "Student");

  async function signOut() {
    try {
      await authApi.logout();
    } finally {
      clearAuthenticatedUser();
      navigate("/login", { replace: true });
    }
  }

  return <div className="stakeholder-app">
    <header className="stakeholder-topbar">
      <Link to={`/${role}/college-overview`} className="stakeholder-brand">
        <span className="stakeholder-brand-icon"><ShieldCheck size={21} /></span>
        <span><strong>ApprovalTrack</strong><small>Student & Faculty Portal</small></span>
      </Link>
      <div className="stakeholder-header-actions">
        <span className="stakeholder-role-select">{faculty ? "Faculty" : "Student"}</span>
        <Link className="stakeholder-quick-complaint" to={quickPath}>
          <AlertTriangle size={16} /><span>Quick Complaint / Whistleblower</span>
        </Link>
        <button className="stakeholder-menu-toggle" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="Toggle stakeholder navigation">
          {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
        <span className="stakeholder-notification" title="Demo notifications"><Bell size={18} /><i>2</i></span>
        <span className="stakeholder-user-avatar" aria-label={displayName}>{displayName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase()}</span>
        <button className="stakeholder-role-select" onClick={signOut}><LogOut size={15} /> Sign out</button>
      </div>
    </header>
    <div className="stakeholder-body">
      {sidebarOpen && <button className="stakeholder-scrim" onClick={() => setSidebarOpen(false)} aria-label="Close menu" />}
      <aside className={`stakeholder-sidebar ${sidebarOpen ? "is-open" : ""}`}>
        <div className="stakeholder-identity">
          <span className="stakeholder-avatar-large">{faculty ? <GraduationCap size={22} /> : <BookOpen size={22} />}</span>
          <div><strong>{displayName}</strong><small>{user?.email || (faculty ? "Faculty workspace" : "Student workspace")}</small></div>
        </div>
        <p className="stakeholder-nav-caption">{faculty ? "FACULTY WORKSPACE" : "STUDENT WORKSPACE"}</p>
        <nav aria-label={`${role} portal navigation`}>
          {links.map(({ label, path, icon: Icon }) => (
            <NavLink
              end
              key={path}
              to={path}
              onClick={() => setSidebarOpen(false)}
              className={({ isActive }) => `stakeholder-nav-link ${isActive ? "active" : ""}`}
            >
              <Icon size={18} strokeWidth={1.8} /><span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="stakeholder-sidebar-footer">
          <span className="stakeholder-readonly"><ShieldCheck size={16} /> Public / demo view</span>
          <small>Demo institution · 2026-27</small>
        </div>
      </aside>
      <main className="stakeholder-main">
        <div className="stakeholder-breadcrumb"><span>Stakeholder Portal</span><span>/</span><strong>{TITLES[location.pathname] || "Portal"}</strong></div>
        <Outlet />
        <footer className="stakeholder-footer">
          <span>ApprovalTrack · Fictional stakeholder demo</span>
          <span>Complaints and reports do not change scores, clocks, or application routing.</span>
        </footer>
      </main>
    </div>
  </div>;
}

export default function StakeholderLayout() {
  return <StakeholderProvider><StakeholderShell /></StakeholderProvider>;
}
