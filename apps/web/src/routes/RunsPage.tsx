import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { getRuns } from "../api.ts";
import { QueryState } from "../components/StateView.tsx";
import { RunHistory } from "../components/RunHistory.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";

export const RUNS_REFRESH_INTERVAL_MS = 2_000;

export function runsQueryOptions(organizationId: string, search = "") {
  return {
    queryKey: ["org", organizationId, "runs", search],
    queryFn: ({ pageParam }: { pageParam: string | null }) => getRuns(organizationId, { cursor: pageParam, search }),
    initialPageParam: null as string | null,
    getNextPageParam: (page: Awaited<ReturnType<typeof getRuns>>) => page.nextCursor ?? undefined,
    enabled: Boolean(organizationId),
    refetchInterval: RUNS_REFRESH_INTERVAL_MS,
  };
}

export function RunsPage() {
  const { organizationId } = useOrganizationFromRoute();
  const [search, setSearch] = useState(() => typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("q") ?? "");
  const query = useInfiniteQuery(runsQueryOptions(organizationId, search));
  const runs = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  return <>
    <header className="runs-heading">
      <div>
        <p className="eyebrow">Runs</p>
        <h1 id="run-history-title">Job Run History</h1>
      </div>
    </header>
    <QueryState error={query.error} isLoading={query.isLoading} isEmpty={!query.isLoading && !query.error && runs.length === 0} retry={() => void query.refetch()} operationLabel="run history" />
    {(runs.length > 0 || search) && <RunHistory runs={runs} onSearchChange={setSearch} />}
    {query.hasNextPage && <button type="button" className="button secondary load-more" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>{query.isFetchingNextPage ? "Loading…" : "Load more runs"}</button>}
  </>;
}

export const runsQueryRefreshInterval = RUNS_REFRESH_INTERVAL_MS;
