import { useQuery } from "@tanstack/react-query";
import { getLlmTokenUsage } from "../api.ts";
import { QueryState } from "./StateView.tsx";
import { AiTokenUsageChart } from "./AiTokenUsageChart.tsx";

export function AiTokenUsage({ overview = false }: { overview?: boolean }) {
  const usage = useQuery({ queryKey: ["admin", "llm-token-usage"], queryFn: getLlmTokenUsage, staleTime: 30_000 });
  return <section className={overview ? "ai-section overview-ai-usage" : "ai-section"} aria-labelledby="ai-token-usage-title">
    <div className="panel-heading"><div><p className="eyebrow">{overview ? "AI / Observe" : "03 / Observe"}</p><h2 id="ai-token-usage-title">AI token usage</h2><p className="form-help">Usage by model · all workspaces · trailing 30 UTC days · LM Studio API cost $0.</p></div></div>
    <QueryState error={usage.error} isLoading={usage.isLoading} retry={() => void usage.refetch()} operationLabel="AI token usage" />
    {usage.data && <AiTokenUsageChart usage={usage.data} />}
  </section>;
}
