import { describe, expect, test } from "bun:test";
import { discoverAvailableRepositoryJobs, listCompletedRunsSince } from "./job-discovery.ts";
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
    expect(await discoverAvailableRepositoryJobs({ db, installationToken: async () => "token" })).toMatchObject({ repositories: 0 });
    expect(selection).toContain("repo.available=true");
    expect(selection).toContain("i.state='approved'");
    expect(selection).not.toContain("repo.approved");
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
      githubFetch: async () => new Response(null, { status: 404 }),
    });
    expect(report).toMatchObject({ repositories: 1, failed: 0 });
    expect(updates).toEqual([[repository.repositoryId]]);
  });

  test.each([403, 429, 500])("keeps repository availability on GitHub %i", async (status) => {
    let selected = false;
    let retired = false;
    const db = (async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
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
      githubFetch: async () => new Response(null, { status }),
    });
    expect(report.failed).toBe(1);
    expect(retired).toBe(false);
  });
});
