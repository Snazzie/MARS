import { useQuery } from "@tanstack/react-query";
import { getWorkerHealth } from "../api.ts";

export function workerHealthQueryOptions(workerId: string, expanded: boolean) {
  return {
    queryKey: ["worker-health", workerId] as const,
    queryFn: () => getWorkerHealth(workerId),
    enabled: expanded && Boolean(workerId),
    refetchInterval: expanded ? 3_000 : false,
    refetchIntervalInBackground: false,
  };
}

export function useWorkerHealth(workerId: string, expanded: boolean) {
  return useQuery(workerHealthQueryOptions(workerId, expanded));
}
