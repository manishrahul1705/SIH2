import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { stakeholderApi } from "../services/stakeholder";
import { useAppStore } from "../store/useAppStore";

const StakeholderContext = createContext(null);

export function StakeholderProvider({ children }) {
  const user = useAppStore((store) => store.user);
  const authenticatedRole = useAppStore((store) => store.role);
  const role = authenticatedRole === "Faculty" ? "faculty" : "student";
  const [state, setState] = useState({ loading: true, error: "", profile: null, institution: null, reports: [] });

  useEffect(() => {
    let active = true;
    setState({ loading: true, error: "", profile: null, institution: null, reports: [] });
    const profileRequest = role === "faculty" ? stakeholderApi.getFacultyProfile() : stakeholderApi.getStudentProfile();
    Promise.all([profileRequest, stakeholderApi.getInstitutions(), role === "faculty" ? stakeholderApi.getYearlyReports() : Promise.resolve([])])
      .then(async ([profiles, institutions, reports]) => {
        const institutionId = user?.institution_id;
        const institutionSummary = (institutions || []).find((item) => item._id === institutionId) || institutions?.[0] || null;
        const institution = institutionSummary ? await stakeholderApi.getInstitution(institutionSummary._id) : null;
        if (!active) return;
        setState({
          loading: false,
          error: "",
          profile: Array.isArray(profiles) ? profiles[0] || null : profiles || null,
          institution,
          reports: Array.isArray(reports) ? reports : [],
        });
      })
      .catch((error) => {
        if (active) setState({ loading: false, error: error.message, profile: null, institution: null, reports: [] });
      });
    return () => { active = false; };
  }, [role, user?.id, user?.institution_id]);

  const value = useMemo(() => ({
    role,
    user,
    loading: state.loading,
    error: state.error,
    profile: state.profile,
    faculty: role === "faculty" ? state.profile : null,
    student: role === "student" ? state.profile : null,
    institution: state.institution,
    reports: state.reports,
    reload: async () => {
      const [profiles, institutions, reports] = await Promise.all([
        role === "faculty" ? stakeholderApi.getFacultyProfile() : stakeholderApi.getStudentProfile(),
        stakeholderApi.getInstitutions(),
        role === "faculty" ? stakeholderApi.getYearlyReports() : Promise.resolve([]),
      ]);
      const institutionSummary = institutions?.find((item) => item._id === user?.institution_id) || institutions?.[0];
      const institution = institutionSummary ? await stakeholderApi.getInstitution(institutionSummary._id) : null;
      setState((current) => ({
        ...current,
        profile: Array.isArray(profiles) ? profiles[0] || null : profiles || null,
        institution,
        reports: Array.isArray(reports) ? reports : [],
        error: "",
      }));
    },
  }), [role, user, state]);

  return <StakeholderContext.Provider value={value}>{children}</StakeholderContext.Provider>;
}

export function useStakeholder() {
  const context = useContext(StakeholderContext);
  if (!context) throw new Error("useStakeholder must be used within StakeholderProvider");
  return context;
}
