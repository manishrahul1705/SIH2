import { Outlet } from "react-router-dom";
import { StakeholderProvider } from "../../context/StakeholderContext";
import AppShell from "../../layouts/AppShell";
import "../../styles/stakeholder.css";

export default function StakeholderLayout() {
  return <div className="stakeholder-app"><StakeholderProvider><AppShell><Outlet /></AppShell></StakeholderProvider></div>;
}
