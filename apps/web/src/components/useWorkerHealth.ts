import { useQuery } from "@tanstack/react-query";
import { getWorkerHealth } from "../api.ts";

export function workerHealthQueryOptions(workerId: string) {
  return {
    queryKey: ["worker-health", workerId] as const,
    queryFn: () => getWorkerHealth(workerId),
    enabled: Boolean(workerId),
    refetchInterval: 3_000,
    refetchIntervalInBackground: false,
  };
}

export function useWorkerHealth(workerId: string) {
  return useQuery(workerHealthQueryOptions(workerId));
}
