import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAppStore } from "../store/useAppStore";
import AppShell, { roleHome } from "../layouts/AppShell";
import { authApi } from "../services/auth";
import LoginPage from "../pages/P01Login";
import DashboardPage from "../pages/P04Dashboard";
import ApplicationPage from "../pages/P05NewApplication";
import CasesPage from "../pages/P06Cases";
import DocumentReviewPage from "../pages/P07DocumentReview";
import DocumentsPage from "../pages/P09DocumentsValidity";
import UndertakingsPage from "../pages/P08Undertakings";
import DeficienciesPage from "../pages/P10Deficiencies";
import NotificationsPage from "../pages/P02Notifications";
import AuditPage from "../pages/P03Audit";
import QueuePage from "../pages/P11OfficerQueue";
import CaseControlPage from "../pages/P12CaseControl";
import VerificationPage from "../pages/P13Verification";
import EvcPage from "../pages/P14Evc";
import HearingsPage from "../pages/P15Hearings";
import DecisionsPage from "../pages/P16Decisions";
import RegionPage from "../pages/P17Region";
import ReportsPage from "../pages/P18Reports";
import PolicyPage from "../pages/P19Policy";
import AlertRulesPage from "../pages/P20AlertRules";
import AiServicePage from "../pages/P21AiService";
import DesignSystemPage from "../pages/DesignSystem";
import EscalationsPage from "../pages/PEscalations";
import { AccessDenied } from "../pages/AccessDenied";
import StakeholderLayout from "../components/layout/StakeholderLayout";
import CollegeOverviewPage from "../pages/shared/CollegeOverviewPage";
import ApprovedOfferingsPage from "../pages/shared/ApprovedOfferingsPage";
import CampusFacilitiesPage from "../pages/shared/CampusFacilitiesPage";
import ComplaintFormPage from "../pages/shared/ComplaintFormPage";
import ComplaintsTrackerPage from "../pages/shared/ComplaintsTrackerPage";
import StatutoryCommitteesPage from "../pages/student/StatutoryCommitteesPage";
import DepartmentRosterPage from "../pages/faculty/DepartmentRosterPage";
import FacultyYearlyReportFormPage from "../pages/faculty/FacultyYearlyReportFormPage";
import FacultyYearlyReportsHistoryPage from "../pages/faculty/FacultyYearlyReportsHistoryPage";

function Guard({ allowed, children, wrapShell = true }) {
  const role = useAppStore((state) => state.role);
  const location = useLocation();
  const signedIn = useAppStore((state) => state.signedIn);
  if (!signedIn) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (!allowed.includes(role)) {
    return <AppShell><AccessDenied /></AppShell>;
  }
  return wrapShell ? <AppShell>{children}</AppShell> : children;
}

const institution = ["Institution user"];
const officers = ["Scrutiny / Regional officer"];
const authorities = ["Competent authority", "Senior authority"];
const oversight = [...officers, ...authorities, "Admin"];

export default function App() {
  const role = useAppStore((state) => state.role);
  const signedIn = useAppStore((state) => state.signedIn);
  const authReady = useAppStore((state) => state.authReady);
  const setAuthenticatedUser = useAppStore((state) => state.setAuthenticatedUser);
  const clearAuthenticatedUser = useAppStore((state) => state.clearAuthenticatedUser);

  useEffect(() => {
    let active = true;
    authApi.me()
      .then(({ user }) => {
        if (active) setAuthenticatedUser(user);
      })
      .catch(() => {
        if (active) clearAuthenticatedUser();
      });
    return () => { active = false; };
  }, [setAuthenticatedUser, clearAuthenticatedUser]);

  if (!authReady) return <main className="auth-loading" aria-live="polite">Checking your sign-in session…</main>;
  const home = roleHome[role] || "/login";
  return <Routes>
    <Route path="/login" element={signedIn ? <Navigate to={home} replace /> : <LoginPage />} />
    <Route path="/" element={<Navigate to={signedIn ? home : "/login"} replace />} />
    <Route path="/dashboard" element={<Guard allowed={institution}><DashboardPage /></Guard>} />
    <Route path="/applications/new" element={<Guard allowed={institution}><ApplicationPage /></Guard>} />
    <Route path="/cases" element={<Guard allowed={[...institution, ...officers]}><CasesPage /></Guard>} />
    <Route path="/documents" element={<Guard allowed={institution}><DocumentsPage /></Guard>} />
    <Route path="/document-review" element={<Guard allowed={[...institution, ...officers]}><DocumentReviewPage /></Guard>} />
    <Route path="/undertakings" element={<Guard allowed={institution}><UndertakingsPage /></Guard>} />
    <Route path="/deficiencies" element={<Guard allowed={institution}><DeficienciesPage /></Guard>} />
    <Route path="/notifications" element={<Guard allowed={["Institution user", ...officers, "EVC member", "SAC/SHC member", ...authorities, "Senior authority", "Admin"]}><NotificationsPage /></Guard>} />
    <Route path="/audit" element={<Guard allowed={["Admin"]}><AuditPage /></Guard>} />
    <Route path="/queue" element={<Guard allowed={officers}><QueuePage /></Guard>} />
    <Route path="/case/:caseId" element={<Guard allowed={["Institution user", ...officers, "EVC member", "SAC/SHC member", ...authorities, "Admin"]}><CaseControlPage /></Guard>} />
    <Route path="/verification" element={<Guard allowed={officers}><VerificationPage /></Guard>} />
    <Route path="/evc" element={<Guard allowed={["EVC member", ...officers]}><EvcPage /></Guard>} />
    <Route path="/evc/visits" element={<Guard allowed={["EVC member", ...officers]}><EvcPage /></Guard>} />
    <Route path="/hearings" element={<Guard allowed={["SAC/SHC member"]}><HearingsPage /></Guard>} />
    <Route path="/decisions" element={<Guard allowed={["Competent authority"]}><DecisionsPage /></Guard>} />
    <Route path="/region" element={<Guard allowed={authorities}><RegionPage /></Guard>} />
    <Route path="/reports" element={<Guard allowed={authorities}><ReportsPage /></Guard>} />
    <Route path="/escalations" element={<Guard allowed={["Senior authority"]}><EscalationsPage /></Guard>} />
    <Route path="/policy" element={<Guard allowed={["Admin"]}><PolicyPage /></Guard>} />
    <Route path="/alert-rules" element={<Guard allowed={["Admin"]}><AlertRulesPage /></Guard>} />
    <Route path="/users" element={<Guard allowed={["Admin"]}><AlertRulesPage usersOnly /></Guard>} />
    <Route path="/ai-service" element={<Guard allowed={["Admin"]}><AiServicePage /></Guard>} />
    <Route path="/design-system" element={<Guard allowed={["Admin"]}><DesignSystemPage /></Guard>} />
    <Route path="/student" element={<Guard allowed={["Student"]} wrapShell={false}><StakeholderLayout /></Guard>}>
      <Route index element={<Navigate to="college-overview" replace />} />
      <Route path="college-overview" element={<CollegeOverviewPage />} />
      <Route path="offerings" element={<ApprovedOfferingsPage />} />
      <Route path="facilities" element={<CampusFacilitiesPage />} />
      <Route path="complaints/new" element={<ComplaintFormPage />} />
      <Route path="complaints" element={<ComplaintsTrackerPage />} />
      <Route path="committees" element={<StatutoryCommitteesPage />} />
    </Route>
    <Route path="/faculty" element={<Guard allowed={["Faculty"]} wrapShell={false}><StakeholderLayout /></Guard>}>
      <Route index element={<Navigate to="college-overview" replace />} />
      <Route path="college-overview" element={<CollegeOverviewPage />} />
      <Route path="offerings" element={<ApprovedOfferingsPage />} />
      <Route path="facilities" element={<CampusFacilitiesPage />} />
      <Route path="department-roster" element={<DepartmentRosterPage />} />
      <Route path="yearly-report/new" element={<FacultyYearlyReportFormPage />} />
      <Route path="yearly-reports" element={<FacultyYearlyReportsHistoryPage />} />
      <Route path="complaints/new" element={<ComplaintFormPage />} />
      <Route path="complaints" element={<ComplaintsTrackerPage />} />
    </Route>
    <Route path="*" element={<AppShell><AccessDenied notFound /></AppShell>} />
  </Routes>;
}
