import { describe, expect, test } from "bun:test";
import { discoverAvailableRepositoryJobs, listCompletedRunsSince } from "./job-discovery.ts";
import { GithubRateLimitError } from "./github-rate-limit.ts";
import type { GithubRunSnapshot } from "./runs.ts";

function run(id: number): GithubRunSnapshot {
  return {
    id,
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
  test("paginates until the persisted completed-run checkpoint", async () => {
    const requestedPages: number[] = [];
    const result = await listCompletedRunsSince(async (page) => {
      requestedPages.push(page);
      const pages = page === 1 ? [run(105), run(104)] : [run(103), run(102)];
      return { totalCount: 5, runs: pages };
    }, 103);

    expect(requestedPages).toEqual([1, 2]);
    expect(result.runs.map(({ id }) => id)).toEqual([105, 104]);
    expect(result.newestRunId).toBe(105);
  });

  test("samples one page when no checkpoint exists", async () => {
    const requestedPages: number[] = [];
    const result = await listCompletedRunsSince(async (page) => {
      requestedPages.push(page);
      return { totalCount: 200, runs: [run(200), run(199)] };
    }, null);

    expect(requestedPages).toEqual([1]);
    expect(result.runs.map(({ id }) => id)).toEqual([200, 199]);
    expect(result.newestRunId).toBe(200);
  });

  test("fails closed when the GitHub completed-run cap hides the checkpoint", async () => {
    await expect(listCompletedRunsSince(async (page) => ({
      totalCount: 2_000,
      runs: Array.from({ length: 100 }, (_, index) => run(2_000 - ((page - 1) * 100) - index)),
    }), 500)).rejects.toThrow("completed_run_checkpoint_unreachable");
  });
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
