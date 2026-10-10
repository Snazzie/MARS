import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { getRuns } from "../api.ts";
import { QueryState } from "../components/StateView.tsx";
import { RunHistory, type RunHistoryFilters, type RunHistoryRange } from "../components/RunHistory.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";

const rangeMs: Record<Exclude<RunHistoryRange, "all">, number> = { "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "12h": 43_200_000, "1d": 86_400_000, "2d": 172_800_000 };

function runsQueryOptions(organizationId: string, filters: { search: string; from?: string; runner: "all" | "mars" | "external" }) {
  return {
    queryKey: ["org", organizationId, "runs", filters],
    queryFn: ({ pageParam }: { pageParam: string | null }) => getRuns(organizationId, { cursor: pageParam, ...filters }),
    initialPageParam: null as string | null,
    getNextPageParam: (page: Awaited<ReturnType<typeof getRuns>>) => page.nextCursor ?? undefined,
    enabled: Boolean(organizationId),
  };
}

export function RunsPage() {
  const { organizationId } = useOrganizationFromRoute();
  const [filters, setFilters] = useState<RunHistoryFilters>(() => {
    const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
    const range = params.get("range") ?? "all";
    const runner = params.get("runner");
    return { search: params.get("q") ?? "", range: Object.hasOwn(rangeMs, range) ? range as RunHistoryRange : "all", runner: runner === "mars" || runner === "external" ? runner : "all" };
  });
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (filters.search) params.set("q", filters.search); else params.delete("q");
    if (filters.range !== "all") params.set("range", filters.range); else params.delete("range");
    if (filters.runner !== "all") params.set("runner", filters.runner); else params.delete("runner");
    window.history.replaceState(null, "", `${window.location.pathname}${params.size ? `?${params}` : ""}${window.location.hash}`);
  }, [filters]);
  const from = useMemo(() => filters.range === "all" ? undefined : new Date(Date.now() - rangeMs[filters.range]).toISOString(), [filters.range, organizationId]);
  const query = useInfiniteQuery(runsQueryOptions(organizationId, { search: filters.search.trim(), from, runner: filters.runner }));
  const runs = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  return <>
    <header className="runs-heading">
      <div>
        <p className="eyebrow">Runs / Jobs</p>
        <h1 id="run-history-title">Job Run History</h1>
      </div>
      <Link className="button secondary" to="/runs/timing">Timing history</Link>
    </header>
    <QueryState error={query.error} isLoading={query.isLoading} retry={() => void query.refetch()} operationLabel="run history" />
    <RunHistory runs={runs} filters={filters} onFiltersChange={setFilters} resultsAvailable={!query.isLoading && !query.error} />
    {query.hasNextPage && <button type="button" className="button secondary load-more" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>{query.isFetchingNextPage ? "Loading…" : "Load more runs"}</button>}
  </>;
}

