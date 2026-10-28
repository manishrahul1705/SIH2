import { create } from "zustand";
import { calculateScore, demoScoreInput } from "../utils/scoreCalculator";
import { workspaceRoleFor } from "../services/auth";

export const useAppStore = create((set) => ({
  role: null,
  user: null,
  signedIn: false,
  authReady: false,
  aiEnabled: true,
  notifications: [],
  deductions: { ...demoScoreInput.deductions },
  score: calculateScore(demoScoreInput).score,
  fireRenewalSimulated: false,
  scoreAnnouncement: "",
  audit: [],
  setAuthenticatedUser: (user) => set({ user, role: workspaceRoleFor(user), signedIn: true, authReady: true }),
  clearAuthenticatedUser: () => set({ user: null, role: null, signedIn: false, authReady: true }),
  setAiEnabled: (aiEnabled) => set({ aiEnabled }),
  setNotifications: (notifications) => set((state) => ({
    notifications: notifications.map((item) => ({
      ...item,
      acknowledged: state.notifications.find((existing) => existing.id === item.id)?.acknowledged ?? item.acknowledged,
    })),
  })),
  acknowledge: (id) => set((state) => ({
    notifications: state.notifications.map((item) => item.id === id ? { ...item, acknowledged: true } : item),
  })),
  simulateFireRenewal: () => set((state) => {
    if (state.fireRenewalSimulated) return { scoreAnnouncement: "Fire renewal simulation is already applied. Verification does not change the score." };
    const deductions = { ...state.deductions, nonLeaseDocuments: Math.max(0, state.deductions.nonLeaseDocuments - 7) };
    return { deductions, fireRenewalSimulated: true, score: calculateScore({ ...demoScoreInput, deductions }).score, scoreAnnouncement: "Fire renewal upload simulated. Action Score is now 70. Verification remains separate." };
  }),
  confirmLease: () => set((state) => {
    const deductions = { ...state.deductions, lease: 10 };
    const score = calculateScore({ ...demoScoreInput, deductions }).score;
    return { deductions, score, scoreAnnouncement: `Lease flag confirmed. 10 points deducted from the Action Score. Score is ${score}.` };
  }),
  logAudit: (entry) => set((state) => ({ audit: [{ id: `AUD-DEMO-${Date.now()}`, time: new Date().toISOString(), ...entry }, ...state.audit] })),
}));
