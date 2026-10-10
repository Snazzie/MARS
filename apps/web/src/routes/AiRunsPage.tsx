import { AiRunQueue } from "../components/AiRunQueue.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";

export function AiRunsPage() {
  const { organizationId } = useOrganizationFromRoute();
  return <div className="ai-runs-page">
    <header className="runs-heading"><p className="eyebrow">Runs / AI</p><h1>AI Run History</h1></header>
    <AiRunQueue organizationId={organizationId} />
  </div>;
}
