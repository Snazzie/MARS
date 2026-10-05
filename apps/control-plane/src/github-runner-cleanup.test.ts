import { expect, test } from "bun:test";
import { preparedTestDatabase } from "../../../packages/db/src/prepared-test-fixture.ts";
import { cleanGithubRunners } from "./github-runner-cleanup.ts";

const runnerName = "BEAST-windows-x64-099a553b-1518-4bb0-9c11-9d40df674988";
const runner = (id: number, name = runnerName, status = "offline") => ({ id, name, status, busy: false, labels: [{ name: "mars-windows-x64-4vcpu-15g" }] });
const repository = { repository: "SpeedHQ/RaceIQ", installationId: 157587463, queued: 1 };

function fixture(options: { tracked?: boolean; active?: boolean; deleteStatus?: number; runners?: unknown[]; inspectionStatus?: number }) {
  const deleted: number[] = [];
  const cleared: string[] = [];
  const db = preparedTestDatabase((name, values) => {
    if (name === "github_runner_cleanup_tracked") return options.tracked ? [{ leaseId: "lease", runnerId: 42, workerName: "BEAST", ...repository }] : [];
    if (name === "github_runner_cleanup_repositories") return [repository];
    if (name === "github_runner_cleanup_workers") return [{ name: "BEAST", id: "worker" }];
    if (name === "github_runner_cleanup_active") return options.active ? [{ id: "active" }] : [];
    if (name === "github_runner_cleanup_owned") return [];
    if (name === "github_runner_cleanup_clear") { cleared.push(String(values.leaseId)); return []; }
    return [];
  });
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "DELETE") {
      deleted.push(Number(url.split("/").at(-1)));
      return options.deleteStatus === 422
        ? Response.json({ message: "Runner is currently running a job" }, { status: 422 })
        : new Response(null, { status: options.deleteStatus ?? 204 });
    }
    if (url.endsWith("/actions/runners/42")) {
      return Response.json({ id: 42, status: "online", busy: true }, { status: options.inspectionStatus ?? 200 });
    }
    return Response.json({ total_count: options.runners?.length ?? 0, runners: options.runners ?? [] });
  };
  return { deleted, cleared, db, fetcher, input: { db, installationToken: async () => "token", githubFetchForInstallation: () => fetcher } };
}

test("deletes a reaped lease's exact runner ID and clears durable identity", async () => {
  const state = fixture({ tracked: true });
  expect(await cleanGithubRunners(state.input)).toEqual({ deleted: 1, failed: 0 });
  expect(state.deleted).toEqual([42]);
  expect(state.cleared).toEqual(["lease"]);
});

test("retains recorded identity for retry when GitHub deletion fails", async () => {
  const state = fixture({ tracked: true, deleteStatus: 503 });
  expect(await cleanGithubRunners(state.input)).toEqual({ deleted: 0, failed: 1 });
  expect(state.cleared).toEqual([]);
});

test("treats a missing registered runner as already removed", async () => {
  const state = fixture({ tracked: true, deleteStatus: 404 });
  expect(await cleanGithubRunners(state.input)).toEqual({ deleted: 1, failed: 0 });
  expect(state.cleared).toEqual(["lease"]);
});

test("reclaims only owned offline legacy runners when the repository has no live leases", async () => {
  const state = fixture({ runners: [runner(1), runner(2, runnerName, "online"), runner(3, "someone-else"), runner(4, "other-windows-x64-099a553b-1518-4bb0-9c11-9d40df674988")] });
  expect(await cleanGithubRunners(state.input)).toEqual({ deleted: 1, failed: 0 });
  expect(state.deleted).toEqual([1]);
  const active = fixture({ active: true, runners: [runner(1)] });
  expect(await cleanGithubRunners(active.input)).toEqual({ deleted: 0, failed: 0 });
  expect(active.deleted).toEqual([]);
});

test("retains a busy runner after rejection and clears it only after a later successful deletion", async () => {
  const options = { tracked: true, deleteStatus: 422 };
  const state = fixture(options);
  expect(await cleanGithubRunners(state.input)).toEqual({ deleted: 0, failed: 1 });
  expect(state.cleared).toEqual([]);
  options.deleteStatus = 204;
  expect(await cleanGithubRunners(state.input)).toEqual({ deleted: 1, failed: 0 });
  expect(state.cleared).toEqual(["lease"]);
});

test("a missing runner during rejection inspection does not hide the failed deletion", async () => {
  const state = fixture({ tracked: true, deleteStatus: 422, inspectionStatus: 404 });
  expect(await cleanGithubRunners(state.input)).toEqual({ deleted: 0, failed: 1 });
  expect(state.cleared).toEqual([]);
});
