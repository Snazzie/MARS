import { expect, test } from "bun:test";
import { reconcileExpiredLeasesWithGithub, reconcileWorkerInventory, terminalLeaseState } from "./lease-reconciliation.ts";

test("does not change an expired lease while GitHub still reports the job active", async () => {
  const queries: string[] = [];
  const db = Object.assign((async (strings: TemplateStringsArray) => {
    queries.push(strings.join(" "));
    return [{ leaseId: "lease-1", organizationId: "org-1", workerId: "worker-1", nonce: "nonce", githubJobId: 42, githubRunId: 7, githubRepositoryId: 99, repositoryName: "repo", repositoryFullName: "acme/repo", installationId: 123 }];
  }) as never, { begin: async () => [] }) as never;
  const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
    const path = String(input);
    if (path.endsWith("/actions/runs/7")) return Response.json({ id: 7, status: "in_progress", name: "ci", run_number: 7, created_at: "2026-08-20T00:00:00Z" });
    return Response.json({ id: 42, run_id: 7, status: "in_progress", name: "build", created_at: "2026-08-20T00:00:00Z" });
  };
  const report = await reconcileExpiredLeasesWithGithub({ db, installationToken: async () => "token", githubFetchForInstallation: () => fetcher });
  expect(report).toEqual({ inspected: 1, completed: 0, stillActive: 1, skipped: 0 });
  expect(queries.some(query => query.includes("UPDATE runner_leases"))).toBe(false);
});

test("maps successful GitHub jobs to completed leases and all other conclusions to failed", () => {
  expect(terminalLeaseState({ conclusion: "success" })).toBe("completed");
  expect(terminalLeaseState({ conclusion: "cancelled" })).toBe("failed");
  expect(terminalLeaseState({ conclusion: null })).toBe("failed");
});
test("worker inventory only reclaims expired runtime leases it does not report", async () => {
  let query = "";
  const db = (async (strings: TemplateStringsArray) => {
    query = strings.join(" ");
    return [{ id: "lease-1" }];
  }) as never;
  expect(await reconcileWorkerInventory(db, "worker-1", ["11111111-1111-4111-8111-111111111111"])).toBe(1);
  expect(query).toContain("expires_at < now()");
  expect(query).toContain("state IN ('dispatched','sandbox_ready','online','busy')");
  expect(query).toContain("NOT (id = ANY");
});
test("worker inventory empty list reclaims all expired runtime leases", async () => {
  let query = "";
  const db = (async (strings: TemplateStringsArray) => {
    query = strings.join(" ");
    return [{ id: "lease-1" }];
  }) as never;
  expect(await reconcileWorkerInventory(db, "worker-1", [])).toBe(1);
  expect(query).toContain("state IN ('dispatched','sandbox_ready','online','busy')");
  expect(query).not.toContain("ANY");
});
