import { describe, expect, test } from "bun:test";
import { listCompletedRunsSince } from "./job-discovery.ts";
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
