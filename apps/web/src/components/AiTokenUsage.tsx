import { useQuery } from "@tanstack/react-query";
import { getLlmTokenUsage } from "../api.ts";
import { QueryState } from "./StateView.tsx";
import { AiTokenUsageChart } from "./AiTokenUsageChart.tsx";

export function AiTokenUsage() {
  const usage = useQuery({ queryKey: ["admin", "llm-token-usage"], queryFn: getLlmTokenUsage, staleTime: 30_000 });
  return <section className="ai-section" aria-labelledby="ai-token-usage-title">
    <div className="panel-heading"><div><p className="eyebrow">03 / Observe</p><h2 id="ai-token-usage-title">AI token usage</h2><p className="form-help">Provider-reported usage and estimated API cost across the trailing 30 UTC days.</p></div></div>
    <QueryState error={usage.error} isLoading={usage.isLoading} retry={() => void usage.refetch()} operationLabel="AI token usage" />
    {usage.data && <AiTokenUsageChart usage={usage.data} />}
  </section>;
}
