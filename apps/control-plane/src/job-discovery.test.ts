import { describe, expect, test } from "bun:test";
import { discoverAvailableRepositoryJobs, discoverQueuedRepositoryJobs, listCompletedRunsSince, syncCompletedJobLogsBestEffort } from "./job-discovery.ts";
import { configureRunLifecycle } from "./runs.ts";
import { GithubRateLimitError } from "./github-rate-limit.ts";
import type { GithubRunSnapshot } from "./runs.ts";

function run(id: number, runAttempt: number): GithubRunSnapshot {
  return {
    id,
    runAttempt,
    runNumber: id,
    workflowName: "CI",
    event: "push",
    branch: "main",
    commitSha: String(id).padStart(40, "0"),
    actorLogin: "octocat",
    status: "completed",
    conclusion: "success",
    queuedAt: "2026-08-13T00:00:00Z",
    startedAt: "2026-08-13T00:00:01Z",
    completedAt: "2026-08-13T00:00:02Z",
  };
}

describe("completed run recovery", () => {
  test("paginates until the persisted completed-run checkpoint pair", async () => {
    const requestedPages: number[] = [];
    const result = await listCompletedRunsSince(async (page) => {
      requestedPages.push(page);
      const pages = page === 1 ? [run(105, 1), run(104, 1)] : [run(103, 2), run(102, 1), run(101, 1)];
      return { totalCount: 5, runs: pages };
    }, { runId: 103, runAttempt: 1 });

    expect(requestedPages).toEqual([1, 2]);
    expect(result.runs.map(({ id }) => id)).toEqual([105, 104, 103, 102, 101]);
    expect(result.newestCheckpoint).toEqual({ runId: 105, runAttempt: 1 });
  });

  test("does not stop on an older checkpoint attempt for the same run ID", async () => {
    const requestedPages: number[] = [];
    const result = await listCompletedRunsSince(async (page) => {
      requestedPages.push(page);
      const pages = page === 1 ? [run(32564909816, 2), run(32564909815, 1)] : [run(32564909816, 1), run(32564909814, 1)];
      return { totalCount: 4, runs: pages };
    }, { runId: 32564909816, runAttempt: 1 });

    expect(requestedPages).toEqual([1, 2]);
    expect(result.runs).toEqual([run(32564909816, 2), run(32564909815, 1)]);
    expect(result.newestCheckpoint).toEqual({ runId: 32564909816, runAttempt: 2 });
  });

  test("stops pagination on an exact completed-run checkpoint pair", async () => {
    const requestedPages: number[] = [];
    const result = await listCompletedRunsSince(async (page) => {
      requestedPages.push(page);
      return { totalCount: 2, runs: page === 1 ? [run(32564909816, 2)] : [run(32564909816, 1)] };
    }, { runId: 32564909816, runAttempt: 1 });

    expect(requestedPages).toEqual([1, 2]);
    expect(result.runs).toEqual([run(32564909816, 2)]);
    expect(result.newestCheckpoint).toEqual({ runId: 32564909816, runAttempt: 2 });
  });

  test("samples one page when no checkpoint exists", async () => {
    const requestedPages: number[] = [];
    const result = await listCompletedRunsSince(async (page) => {
      requestedPages.push(page);
      return { totalCount: 200, runs: [run(200, 1), run(199, 1)] };
    }, null);

    expect(requestedPages).toEqual([1]);
    expect(result.runs.map(({ id }) => id)).toEqual([200, 199]);
    expect(result.newestCheckpoint).toEqual({ runId: 200, runAttempt: 1 });
  });

  test("fails closed when the GitHub completed-run cap hides the checkpoint", async () => {
    await expect(listCompletedRunsSince(async (page) => ({
      totalCount: 2_000,
      runs: Array.from({ length: 100 }, (_, index) => run(2_000 - ((page - 1) * 100) - index, 1)),
    }), { runId: 500, runAttempt: 1 })).rejects.toThrow("completed_run_checkpoint_unreachable");
  });
});

test("completed log backfill failure does not abort authoritative status discovery", async () => {
  const errors: Array<{ jobId: number; error: string }> = [];
  const synced = await syncCompletedJobLogsBestEffort(96580319653, async () => {
    throw new Error("github_job_logs_not_ready");
  }, (jobId, error) => errors.push({ jobId, error }));
  expect(synced).toBe(false);
  expect(errors).toEqual([{ jobId: 96580319653, error: "github_job_logs_not_ready" }]);
});
test("pairs rerun attempts during repository discovery", async () => {
  const repository = { repositoryId: "11111111-1111-4111-8111-111111111111", githubRepositoryId: 7, name: "repo", fullName: "acme/repo", installationId: 42 };
  const requests: string[] = [];
  const persistedRuns: Array<{ runId: number; runAttempt: number; status: string }> = [];
  const persistedJobs: Array<{ runId: number; runAttempt: number; status: string; githubJobId: number }> = [];
  const execute = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" ");
    if (query.includes("FROM dashboard_installations")) return [{ id: "installation", organization_id: "org" }];
    if (query.includes("SELECT id FROM dashboard_repositories")) return [{ id: "repository" }];
    if (query.startsWith("INSERT INTO dashboard_runs")) {
      const attemptQualified = query.includes("run_attempt");
      const githubRunId = Number(values[2]);
      const runAttempt = attemptQualified ? Number(values[3]) : 1;
      const status = String(values[attemptQualified ? 10 : 9]);
      persistedRuns.push({ runId: githubRunId, runAttempt, status });
      return [{ id: `run-${githubRunId}`, status, run_attempt: runAttempt }];
    }
    if (query.startsWith("INSERT INTO dashboard_jobs")) {
      const attemptQualified = query.includes("run_attempt");
      const githubJobId = Number(values[attemptQualified ? 3 : 2]);
      const runAttempt = attemptQualified ? Number(values[2]) : 1;
      const runId = Number(String(values[1]).replace(/^run-/, ""));
      const status = String(values[attemptQualified ? 5 : 4]);
      persistedJobs.push({ runId, githubJobId, runAttempt, status });
      return [{ id: `job-${githubJobId}`, status, run_attempt: runAttempt }];
    }
    if (query.includes("FROM dashboard_repositories repo")) return [repository];
    return [];
  };
  const db = Object.assign(execute, { begin: async (callback: (tx: typeof execute) => Promise<unknown>) => callback(execute) }) as never;
  configureRunLifecycle(db as never);
  const githubFetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("status=completed")) {
      return Response.json({
        total_count: 1,
        workflow_runs: [{ id: 32564909816, run_number: 42, run_attempt: 1, name: "CI", event: "push", head_branch: "main", head_sha: "a".repeat(40), actor: { login: "octocat" }, status: "completed", conclusion: "failure", created_at: "2026-08-22T10:30:00Z", run_started_at: "2026-08-22T10:30:01Z", updated_at: "2026-08-22T10:31:17Z" }],
      });
    }
    if (url.includes("/attempts/2/jobs")) {
      return Response.json({ total_count: 1, jobs: [{ id: 97018978327, run_id: 32564909816, run_attempt: 2, name: "windows", status: "queued", conclusion: null, labels: ["self-hosted", "windows"], created_at: "2026-08-22T10:31:46Z", started_at: null, completed_at: null, steps: [] }] });
    }
    return Response.json({
      total_count: 1,
      workflow_runs: [{ id: 32564909816, run_number: 42, run_attempt: 2, name: "CI", event: "push", head_branch: "main", head_sha: "a".repeat(40), actor: { login: "octocat" }, status: "queued", conclusion: null, created_at: "2026-08-22T10:31:46Z", run_started_at: null, updated_at: "2026-08-22T10:31:46Z" }],
    });
  };

  const report = await discoverAvailableRepositoryJobs({ db, installationToken: async () => "token", githubFetchForInstallation: () => githubFetch });

  expect(report).toMatchObject({ repositories: 1, discovered: 1, updated: 1, failed: 0 });
  expect(persistedRuns).toContainEqual({ runId: 32564909816, runAttempt: 2, status: "queued" });
  expect(persistedJobs).toContainEqual({ runId: 32564909816, githubJobId: 97018978327, runAttempt: 2, status: "queued" });
  expect(requests.some((url) => url === "https://api.github.com/repos/acme/repo/actions/runs/32564909816/attempts/2/jobs?per_page=100&page=1")).toBe(true);
  expect(requests.some((url) => url.includes("/actions/runs/32564909816/jobs?filter=latest"))).toBe(false);
});

describe("repository authorization lifecycle", () => {
  const repository = { repositoryId: "11111111-1111-4111-8111-111111111111", githubRepositoryId: 7, name: "repo", fullName: "acme/repo", installationId: 42 };

  test("discovers every available repository on an active installation", async () => {
    let selection = "";
    const db = (async (strings: TemplateStringsArray) => {
      selection = strings.join(" ");
      return [];
    }) as never;
    expect(await discoverAvailableRepositoryJobs({ db, installationToken: async () => "token", githubFetchForInstallation: () => fetch })).toMatchObject({ repositories: 0 });
    expect(selection).toContain("repo.available=true");
    expect(selection).toContain("i.state='approved'");
    expect(selection).not.toContain("repo.approved");
    expect(selection).toContain("repo.discovery_retry_at IS NULL OR repo.discovery_retry_at<=now()");
  });

  test("retires only a repository that GitHub reports missing", async () => {
    const updates: unknown[][] = [];
    let selected = false;
    const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join(" ");
      if (!selected && query.includes("FROM dashboard_repositories repo")) {
        selected = true;
        return [repository];
      }
      if (query.includes("UPDATE dashboard_repositories SET available=false")) updates.push(values);
      return [];
    }) as never;
    const report = await discoverAvailableRepositoryJobs({
      db,
      installationToken: async () => "token",
      githubFetchForInstallation: () => async () => new Response(null, { status: 404 }),
    });
    expect(report).toMatchObject({ repositories: 1, failed: 0 });
    expect(updates).toEqual([[repository.repositoryId]]);
  });

  test("pauses a repository for 24 hours after GitHub 403", async () => {
    let selected = false;
    const queries: string[] = [];
    const db = (async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      queries.push(query);
      if (!selected && query.includes("FROM dashboard_repositories repo")) {
        selected = true;
        return [{ ...repository, discoveryError: null, discoveryRetryAt: null }];
      }
      return [];
    }) as never;

    const report = await discoverAvailableRepositoryJobs({
      db,
      installationToken: async () => "token",
      githubFetchForInstallation: () => async () => new Response(null, { status: 403 }),
    });

    expect(report).toMatchObject({ repositories: 1, failed: 1 });
    expect(queries.some((query) => query.includes("discovery_error='github_403'") && query.includes("interval '24 hours'"))).toBe(true);
  });

  test("clears a queued 403 cooldown after successful discovery", async () => {
    let selected = false;
    const queries: string[] = [];
    const db = (async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      queries.push(query);
      if (!selected && query.includes("FROM dashboard_repositories repo")) {
        selected = true;
        return [{ ...repository, discoveryError: "github_403", discoveryRetryAt: new Date("2026-08-14T12:00:00.000Z") }];
      }
      return [];
    }) as never;
    const githubFetch = async () => Response.json({ total_count: 0, workflow_runs: [] });

    expect(await discoverAvailableRepositoryJobs({ db, installationToken: async () => "token", githubFetchForInstallation: () => githubFetch })).toMatchObject({ repositories: 1, failed: 0 });
    expect(queries.some((query) => query.includes("SET discovery_error=NULL,discovery_retry_at=NULL"))).toBe(true);
  });

  test.each([429, 500])("keeps normal-cycle retry behavior on GitHub %i", async (status) => {
    let selected = false;
    let retired = false;
    const queries: string[] = [];
    const db = (async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      queries.push(query);
      if (!selected && query.includes("FROM dashboard_repositories repo")) {
        selected = true;
        return [repository];
      }
      if (query.includes("UPDATE dashboard_repositories SET available=false")) retired = true;
      return [];
    }) as never;
    const report = await discoverAvailableRepositoryJobs({
      db,
      installationToken: async () => "token",
      githubFetchForInstallation: () => async () => new Response(null, { status }),
    });
    expect(report.failed).toBe(1);
    expect(retired).toBe(false);
    expect(queries.some((query) => query.includes("SET discovery_error="))).toBe(false);
  });
  test("pauses queued pickup during an installation rate-limit cooldown", async () => {
    const resetAt = Date.parse("2026-08-16T01:00:00.000Z");
    const queries: string[] = [];
    const valuesSeen: unknown[][] = [];
    let selected = false;
    const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join(" ");
      queries.push(query);
      valuesSeen.push(values);
      if (!selected && query.includes("FROM dashboard_repositories repo")) {
        selected = true;
        return [repository];
      }
      return [];
    }) as never;
    const githubFetch = async () => {
      throw new GithubRateLimitError(repository.installationId, resetAt);
    };

    const report = await discoverQueuedRepositoryJobs({
      db,
      installationToken: async () => "token",
      githubFetchForInstallation: () => githubFetch,
      repositoryFullName: repository.fullName,
    });

    expect(report).toMatchObject({ repositories: 1, failed: 1 });
    expect(queries[0]).toContain("repo.discovery_retry_at IS NULL OR repo.discovery_retry_at<=now()");
    expect(queries.some(query => query.includes("discovery_error='github_rate_limited'"))).toBe(true);
    expect(valuesSeen.at(-1)).toEqual([new Date(resetAt).toISOString(), repository.repositoryId]);
  });
});

test("fast pickup polls only queued runs for one configured repository", async () => {
  const repository = { repositoryId: "11111111-1111-4111-8111-111111111111", githubRepositoryId: 7, name: "repo", fullName: "acme/repo", installationId: 42 };
  const requests: string[] = [];
  const db = (async (strings: TemplateStringsArray) => strings.join(" ").includes("FROM dashboard_repositories repo") ? [repository] : []) as never;
  const githubFetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("status=queued") || !url.includes("status=")) return Response.json({
      total_count: 1,
      workflow_runs: [{
        id: 77,
        run_number: 77,
        run_attempt: 1,
        name: "CI",
        event: "push",
        head_branch: "main",
        head_sha: "a".repeat(40),
        actor: { login: "octocat" },
        status: "queued",
        conclusion: null,
        created_at: "2026-08-15T04:00:00Z",
        run_started_at: null,
        updated_at: "2026-08-15T04:00:00Z",
      }],
    });
    if (url.includes("/actions/runs/77/jobs")) return Response.json({ total_count: 0, jobs: [] });
    return Response.json({ total_count: 0, workflow_runs: [] });
  };

  const report = await discoverQueuedRepositoryJobs({
    db,
    installationToken: async () => "token",
    githubFetchForInstallation: () => githubFetch,
    repositoryFullName: "acme/repo",
  });

  expect(requests).toHaveLength(2);
  expect(requests[0]).not.toContain("status=");
  expect(requests.some((url) => url.includes("status=in_progress") || url.includes("status=completed") || url.includes("status=pending") || url.includes("status=queued"))).toBe(false);
});
test("fast pickup includes GitHub pending runs", async () => {
  const repository = { repositoryId: "11111111-1111-4111-8111-111111111111", githubRepositoryId: 7, name: "repo", fullName: "acme/repo", installationId: 42 };
  const requests: string[] = [];
  const db = (async (strings: TemplateStringsArray) => strings.join(" ").includes("FROM dashboard_repositories repo") ? [repository] : []) as never;
  const githubFetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (!url.includes("status=")) return Response.json({
      total_count: 1,
      workflow_runs: [{
        id: 77, run_number: 77, run_attempt: 1, name: "CI", event: "pull_request", head_branch: "main", head_sha: "a".repeat(40),
        actor: { login: "octocat" }, status: "pending", conclusion: null, created_at: "2026-08-15T04:00:00Z",
        run_started_at: null, updated_at: "2026-08-15T04:00:00Z",
      }],
    });
    if (url.includes("/actions/runs/77/jobs")) return Response.json({ total_count: 0, jobs: [] });
    return Response.json({ total_count: 0, workflow_runs: [] });
  };

  const report = await discoverQueuedRepositoryJobs({
    db,
    installationToken: async () => "token",
    githubFetchForInstallation: () => githubFetch,
    repositoryFullName: repository.fullName,
  });

  expect(report).toMatchObject({ repositories: 1, discovered: 0, failed: 0 });
  expect(requests.some((url) => !url.includes("status="))).toBe(true);
});

test("stops only the rate-limited installation's remaining repositories", async () => {
  const rows = [
    { repositoryId: "11111111-1111-4111-8111-111111111111", githubRepositoryId: 1, name: "one", fullName: "acme/one", installationId: 42 },
    { repositoryId: "22222222-2222-4222-8222-222222222222", githubRepositoryId: 2, name: "two", fullName: "acme/two", installationId: 42 },
    { repositoryId: "33333333-3333-4333-8333-333333333333", githubRepositoryId: 3, name: "three", fullName: "acme/three", installationId: 43 },
  ];
  let selected = false;
  const queries: string[] = [];
  const db = (async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    queries.push(query);
    if (!selected && query.includes("FROM dashboard_repositories repo")) {
      selected = true;
      return rows;
    }
    return [];
  }) as never;
  const requests: string[] = [];
  const githubFetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/repos/acme/one/")) throw new GithubRateLimitError(42, Date.now() + 60_000);
    return Response.json({ total_count: 0, workflow_runs: [] });
  };

  const report = await discoverAvailableRepositoryJobs({ db, installationToken: async () => "token", githubFetchForInstallation: () => githubFetch });

  expect(requests.some((url) => url.includes("/repos/acme/two/"))).toBe(false);
  expect(requests.some((url) => url.includes("/repos/acme/three/"))).toBe(true);
  expect(queries.some((query) => query.includes("discovery_error='github_403'"))).toBe(false);
  expect(report.failed).toBe(1);
});
