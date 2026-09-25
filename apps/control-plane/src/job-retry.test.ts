import { expect, test } from "bun:test";
import type { DatabaseClient } from "@mars/db";
import { retryFailedGithubJobs } from "./job-retry.ts";

type Row = { id: string; organizationId: string; githubRunId: number; runAttempt: number; githubJobId: number; requestedLabels: string[]; fullName: string; installationId: number };
const labels = ["mars-any-2vcpu-4g", "mars-retry-3"];
function fixture() {
  const rows: Row[] = [{ id: "run-1", organizationId: "org-1", githubRunId: 101, runAttempt: 1, githubJobId: 201, requestedLabels: labels, fullName: "acme/project", installationId: 9 }];
  let claimed: number | null = null;
  let runStatus = "completed";
  let jobConclusion = "failure";
  let githubAttempt = 1;
  let eligible = true;
  let responseStatus = 201;
  const requests: Request[] = [];
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (strings[0]?.includes("SELECT r.id")) return eligible && runStatus === "completed" && claimed !== rows[0]!.runAttempt && ["failure", "timed_out"].includes(jobConclusion) ? rows : [];
    if (strings[0]?.includes("UPDATE dashboard_runs")) {
      if (claimed === values[2] || !eligible || runStatus !== "completed" || rows[0]!.runAttempt !== values[2]) return [];
      claimed = Number(values[2]);
      return [{ id: rows[0]!.id }];
    }
    throw new Error(`Unexpected SQL ${strings[0]}`);
  };
  const deps = {
    db: sql as unknown as DatabaseClient,
    installationToken: async () => "installation-token",
    githubFetchForInstallation: () => async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === "POST") return new Response(null, { status: responseStatus });
      if (request.url.endsWith("/actions/runs/101")) return Response.json({ id: 101, run_attempt: githubAttempt, status: runStatus });
      return Response.json({ id: 201, run_id: 101, run_attempt: githubAttempt, status: "completed", conclusion: jobConclusion, labels });
    },
  };
  return { rows, deps, requests, get claimed() { return claimed; }, set runStatus(value: string) { runStatus = value; }, set jobConclusion(value: string) { jobConclusion = value; }, set githubAttempt(value: number) { githubAttempt = value; }, set eligible(value: boolean) { eligible = value; }, set responseStatus(value: number) { responseStatus = value; } };
}

const posts = (requests: Request[]) => requests.filter(request => request.method === "POST");

test("claims each completed failed attempt once, through three additional executions", async () => {
  const state = fixture();
  for (let attempt = 1; attempt <= 4; attempt++) {
    state.rows[0]!.runAttempt = attempt;
    state.githubAttempt = attempt;
    const report = await retryFailedGithubJobs(state.deps);
    expect(report.requested).toBe(attempt <= 3 ? 1 : 0);
    expect((await retryFailedGithubJobs(state.deps)).requested).toBe(0);
  }
  expect(posts(state.requests)).toHaveLength(3);
  expect(posts(state.requests).map(request => request.url)).toEqual(Array(3).fill("https://api.github.com/repos/acme/project/actions/jobs/201/rerun"));
  expect(state.claimed).toBe(3);
});

test("skips incomplete, successful, cancelled, unlabeled, stale and historical snapshots", async () => {
  for (const reason of ["incomplete", "success", "cancelled", "unlabeled", "stale", "historical"]) {
    const state = fixture();
    if (reason === "incomplete") state.runStatus = "in_progress";
    if (reason === "success" || reason === "cancelled") state.jobConclusion = reason;
    if (reason === "unlabeled") state.rows[0]!.requestedLabels = [labels[0]!];
    if (reason === "stale") state.githubAttempt = 2;
    if (reason === "historical") state.eligible = false;
    expect((await retryFailedGithubJobs(state.deps)).requested).toBe(0);
    expect(posts(state.requests)).toHaveLength(0);
    expect(state.claimed).toBeNull();
  }
});

test("selects only the lowest eligible failed job ID for a run attempt", async () => {
  const state = fixture();
  state.rows.push({ ...state.rows[0]!, githubJobId: 202 });
  expect((await retryFailedGithubJobs(state.deps)).requested).toBe(1);
  expect(posts(state.requests)).toHaveLength(1);
  expect(posts(state.requests)[0]!.url).toContain("/jobs/201/rerun");
});

test("retains claim after GitHub rejects the POST", async () => {
  const state = fixture();
  state.responseStatus = 403;
  expect((await retryFailedGithubJobs(state.deps)).failed).toBe(1);
  expect(state.claimed).toBe(1);
  expect((await retryFailedGithubJobs(state.deps)).requested).toBe(0);
  expect(posts(state.requests)).toHaveLength(1);
});

test("a losing concurrent claim cannot issue another POST", async () => {
  const state = fixture();
  const [first, second] = await Promise.all([retryFailedGithubJobs(state.deps), retryFailedGithubJobs(state.deps)]);
  expect(first.requested + second.requested).toBe(1);
  expect(posts(state.requests)).toHaveLength(1);
});
