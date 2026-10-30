import { useParams } from "react-router-dom";
import { useAppStore } from "../store/useAppStore";
import DomainWorkspace from "./DomainWorkspace";
import EvcWorkspace from "./evc/EvcWorkspace";

export default function CasesPage() {
  const role = useAppStore((state) => state.role);
  const { caseId } = useParams();
  if (role === "EVC member" || role === "EVC chairman") {
    return <EvcWorkspace basePath="/cases" />;
  }
  if (caseId) return null;
  return <DomainWorkspace kind="cases" />;
}
