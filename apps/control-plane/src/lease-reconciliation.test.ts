import { expect, test } from "bun:test";
import { preparedTestDatabase } from "../../../packages/db/src/prepared-test-fixture.ts";
import { reconcileExpiredLeasesWithGithub, reconcileWorkerInventory, terminalLeaseState } from "./lease-reconciliation.ts";

const activeLease = {
  leaseId: "lease-1", organizationId: "org-1", workerId: "worker-1", nonce: "nonce", leaseState: "online", leaseExpired: true,
  githubJobId: 42, githubRunId: 7, githubRunAttempt: 2, githubRepositoryId: 99, repositoryName: "repo",
  repositoryFullName: "acme/repo", installationId: 123, jobStatus: "in_progress", jobConclusion: null,
};
const fetchActiveJob = async (input: RequestInfo | URL): Promise<Response> => {
  if (String(input).endsWith("/actions/runs/7/attempts/2")) return Response.json({ id: 7, run_attempt: 2, status: "in_progress", name: "ci", run_number: 7, created_at: "2026-08-20T00:00:00Z" });
  return Response.json({ id: 42, run_id: 7, run_attempt: 2, status: "in_progress", name: "build", created_at: "2026-08-20T00:00:00Z" });
};

test("does not change an expired lease while GitHub still reports the job active", async () => {
  const requests: string[] = [];
  const db = preparedTestDatabase(name => {
    if (name === "lease_reconciliation_stale_leases") return [activeLease];
    return [];
  });
  const report = await reconcileExpiredLeasesWithGithub({
    db, installationToken: async () => "token",
    githubFetchForInstallation: () => async input => { requests.push(String(input)); return fetchActiveJob(input); },
  });
  expect(report).toEqual({ inspected: 1, completed: 0, released: 0, stillActive: 1, skipped: 0 });
  expect(requests[0]).toContain("/actions/jobs/42");
});
test("maps successful GitHub jobs to completed leases and all other conclusions to failed", () => {
  expect(terminalLeaseState({ conclusion: "success" })).toBe("completed");
  expect(terminalLeaseState({ conclusion: "cancelled" })).toBe("failed");
  expect(terminalLeaseState({ conclusion: null })).toBe("failed");
});

test("worker inventory reclaims runtime leases it does not report", async () => {
  const db = preparedTestDatabase((name, parameters) => {
    expect(name).toBe("lease_reconciliation_inventory");
    expect(parameters).toMatchObject({ workerId: "worker-1", activeLeaseIds: JSON.stringify(["11111111-1111-4111-8111-111111111111"]) });
    return [{ id: "lease-1" }];
  });
  expect(await reconcileWorkerInventory(db, "worker-1", ["11111111-1111-4111-8111-111111111111"])).toBe(1);
});

test("worker inventory empty list reclaims runtime leases and completed cleanup", async () => {
  const db = preparedTestDatabase(name => name === "lease_reconciliation_inventory_empty" ? [{ id: "runtime-lease" }, { id: "terminal-lease" }] : []);
  expect(await reconcileWorkerInventory(db, "worker-1", [])).toBe(2);
});

test("terminalizes a sandbox-ready lease when exact GitHub job lookup returns 404", async () => {
  const calls: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  const row = { ...activeLease, leaseId: "lease-404", nonce: "nonce-404", leaseState: "sandbox_ready", leaseExpired: false };
  const db = preparedTestDatabase((name, parameters) => {
    calls.push({ name, parameters });
    if (name === "lease_reconciliation_stale_leases") return [row];
    if (name === "run_lifecycle_mark_job_missing") return [{ id: "job-1" }];
    if (name === "lease_reconciliation_missing_active") return [{ id: row.leaseId }];
    return [];
  });
  const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
    expect(String(input)).toContain("/actions/jobs/42");
    return new Response(null, { status: 404 });
  };
  const report = await reconcileExpiredLeasesWithGithub({ db, installationToken: async () => "token", githubFetchForInstallation: () => fetcher });
  expect(report).toEqual({ inspected: 1, completed: 0, released: 1, stillActive: 0, skipped: 0 });
  expect(calls.find(call => call.name === "lease_reconciliation_missing_active")?.parameters.terminalResult).toBe(JSON.stringify({ reason: "github_job_not_found" }));
});

test("fails an expired sandbox-ready lease with startup timeout while the job remains nonterminal", async () => {
  const row = { ...activeLease, leaseId: "lease-timeout", nonce: "nonce-timeout", leaseState: "sandbox_ready" };
  const calls: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  const db = preparedTestDatabase((name, parameters) => {
    calls.push({ name, parameters });
    if (name === "lease_reconciliation_stale_leases") return [row];
    if (name === "lease_reconciliation_startup_failure") return [{ id: row.leaseId }];
    return [];
  });
  const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
    const path = String(input);
    if (path.endsWith("/actions/jobs/42")) return Response.json({ id: 42, run_id: 7, run_attempt: 2, status: "in_progress", name: "build", created_at: "2026-08-20T00:00:00Z" });
    if (path.endsWith("/actions/runs/7/attempts/2")) return Response.json({ id: 7, run_attempt: 2, status: "in_progress", name: "ci", run_number: 7, created_at: "2026-08-20T00:00:00Z" });
    throw new Error(`unexpected GitHub request: ${path}`);
  };
  const report = await reconcileExpiredLeasesWithGithub({ db, installationToken: async () => "token", githubFetchForInstallation: () => fetcher });
  expect(report).toEqual({ inspected: 1, completed: 0, released: 1, stillActive: 0, skipped: 0 });
  expect(calls.find(call => call.name === "lease_reconciliation_startup_failure")?.parameters.terminalResult).toBe(JSON.stringify({ reason: "startup_timeout" }));
});

test("fails an expired provisioning lease with startup timeout while the job remains nonterminal", async () => {
  const row = { ...activeLease, leaseId: "lease-provisioning-timeout", nonce: "nonce-provisioning-timeout", githubJobId: 43, githubRunId: 8, githubRunAttempt: 1, leaseState: "provisioning" };
  const calls: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  const db = preparedTestDatabase((name, parameters) => {
    calls.push({ name, parameters });
    if (name === "lease_reconciliation_stale_leases") return [row];
    if (name === "lease_reconciliation_startup_failure") return [{ id: row.leaseId }];
    return [];
  });
  const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
    const path = String(input);
    if (path.endsWith("/actions/jobs/43")) return Response.json({ id: 43, run_id: 8, run_attempt: 1, status: "queued", name: "build", created_at: "2026-08-20T00:00:00Z" });
    throw new Error(`unexpected GitHub request: ${path}`);
  };
  const report = await reconcileExpiredLeasesWithGithub({ db, installationToken: async () => "token", githubFetchForInstallation: () => fetcher });
  expect(report).toEqual({ inspected: 1, completed: 0, released: 1, stillActive: 0, skipped: 0 });
  expect(calls.find(call => call.name === "lease_reconciliation_startup_failure")?.parameters.terminalResult).toBe(JSON.stringify({ reason: "startup_timeout" }));
});

