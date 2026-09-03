import { expect, test } from "bun:test";
import { reconcileExpiredLeasesWithGithub, reconcileWorkerInventory, terminalLeaseState } from "./lease-reconciliation.ts";

test("does not change an expired lease while GitHub still reports the job active", async () => {
  const queries: string[] = [];
  const requests: string[] = [];
  const db = Object.assign((async (strings: TemplateStringsArray) => {
    queries.push(strings.join(" "));
    return [{ leaseId: "lease-1", organizationId: "org-1", workerId: "worker-1", nonce: "nonce", githubJobId: 42, githubRunId: 7, githubRunAttempt: 2, githubRepositoryId: 99, repositoryName: "repo", repositoryFullName: "acme/repo", installationId: 123 }];
  }) as never, { begin: async () => [] }) as never;
  const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
    const path = String(input);
    requests.push(path);
    if (path.endsWith("/actions/runs/7/attempts/2")) return Response.json({ id: 7, run_attempt: 2, status: "in_progress", name: "ci", run_number: 7, created_at: "2026-08-20T00:00:00Z" });
    return Response.json({ id: 42, run_id: 7, run_attempt: 2, status: "in_progress", name: "build", created_at: "2026-08-20T00:00:00Z" });
  };
  const report = await reconcileExpiredLeasesWithGithub({ db, installationToken: async () => "token", githubFetchForInstallation: () => fetcher });
  expect(report).toEqual({ inspected: 1, completed: 0, released: 0, stillActive: 1, skipped: 0 });
  expect(requests[0]).toContain("/actions/jobs/42");
  expect(requests[1]).toContain("/actions/runs/7/attempts/2");
  expect(queries.some(query => query.includes("UPDATE runner_leases"))).toBe(false);
});

test("maps successful GitHub jobs to completed leases and all other conclusions to failed", () => {
  expect(terminalLeaseState({ conclusion: "success" })).toBe("completed");
  expect(terminalLeaseState({ conclusion: "cancelled" })).toBe("failed");
  expect(terminalLeaseState({ conclusion: null })).toBe("failed");
});
test("worker inventory reclaims runtime leases it does not report", async () => {
  let query = "";
  const db = (async (strings: TemplateStringsArray) => {
    query = strings.join(" ");
    return [{ id: "lease-1" }];
  }) as never;
  expect(await reconcileWorkerInventory(db, "worker-1", ["11111111-1111-4111-8111-111111111111"])).toBe(1);
  expect(query).not.toContain("expires_at < now()");
  expect(query).toContain("state IN ('dispatched','sandbox_ready','online','busy')");
  expect(query).not.toContain("ANY((");
  expect(query).toContain("jsonb_array_elements_text");
});
test("worker inventory empty list reclaims all runtime leases", async () => {
  let query = "";
  const db = (async (strings: TemplateStringsArray) => {
    query = strings.join(" ");
    return [{ id: "lease-1" }];
  }) as never;
  expect(await reconcileWorkerInventory(db, "worker-1", [])).toBe(1);
  expect(query).toContain("state IN ('dispatched','sandbox_ready','online','busy')");
  expect(query).not.toContain("expires_at < now()");
  expect(query).not.toContain("ANY");
});

test("terminalizes a sandbox-ready lease when exact GitHub job lookup returns 404", async () => {
  const calls: Array<{ query: string; values: unknown[] }> = [];
  const db = Object.assign((async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" ");
    calls.push({ query, values });
    if (query.includes("FROM runner_leases l")) return [{
      leaseId: "lease-404", organizationId: "org-1", workerId: "worker-1", nonce: "nonce-404", leaseState: "sandbox_ready",
      githubJobId: 42, githubRunId: 7, githubRunAttempt: 2, githubRepositoryId: 99, repositoryName: "repo",
      repositoryFullName: "acme/repo", installationId: 123, jobStatus: "in_progress", jobConclusion: null,
    }];
    if (query.includes("UPDATE dashboard_jobs") || query.includes("UPDATE runner_leases")) return [{ id: "lease-404" }];
    return [];
  }) as never, { begin: async (fn: (tx: typeof db) => unknown) => fn(db) }) as never;
  const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
    expect(String(input)).toContain("/actions/jobs/42");
    return new Response(null, { status: 404 });
  };

  const report = await reconcileExpiredLeasesWithGithub({ db, installationToken: async () => "token", githubFetchForInstallation: () => fetcher });

  expect(report).toEqual({ inspected: 1, completed: 0, released: 1, stillActive: 0, skipped: 0 });
  expect(calls.some(({ query }) => query.includes("UPDATE runner_leases") && query.includes("cleanup_state='pending'"))).toBe(true);
  expect(calls.some(({ values }) => values.some(value => value && typeof value === "object" && JSON.stringify(value).includes("github_job_not_found")))).toBe(true);
});

test("fails an expired sandbox-ready lease with startup timeout while the job remains nonterminal", async () => {
  const calls: Array<{ query: string; values: unknown[] }> = [];
  const db = Object.assign((async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" ");
    calls.push({ query, values });
    if (query.includes("FROM runner_leases l")) return [{
      leaseId: "lease-timeout", organizationId: "org-1", workerId: "worker-1", nonce: "nonce-timeout", leaseState: "sandbox_ready",
      githubJobId: 42, githubRunId: 7, githubRunAttempt: 2, githubRepositoryId: 99, repositoryName: "repo",
      repositoryFullName: "acme/repo", installationId: 123, jobStatus: "in_progress", jobConclusion: null,
    }];
    if (query.includes("UPDATE runner_leases")) return [{ id: "lease-timeout" }];
    return [];
  }) as never, { begin: async (fn: (tx: typeof db) => unknown) => fn(db) }) as never;
  const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
    const path = String(input);
    if (path.endsWith("/actions/jobs/42")) return Response.json({ id: 42, run_id: 7, run_attempt: 2, status: "in_progress", name: "build", created_at: "2026-08-20T00:00:00Z" });
    if (path.endsWith("/actions/runs/7/attempts/2")) return Response.json({ id: 7, run_attempt: 2, status: "in_progress", name: "ci", run_number: 7, created_at: "2026-08-20T00:00:00Z" });
    throw new Error(`unexpected GitHub request: ${path}`);
  };

  const report = await reconcileExpiredLeasesWithGithub({ db, installationToken: async () => "token", githubFetchForInstallation: () => fetcher });

  expect(report).toEqual({ inspected: 1, completed: 0, released: 1, stillActive: 0, skipped: 0 });
  expect(calls.some(({ query, values }) => query.includes("UPDATE runner_leases") && values.some(value => value && typeof value === "object" && JSON.stringify(value).includes("startup_timeout")))).toBe(true);
});
