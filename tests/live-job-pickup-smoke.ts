import { createDb, getOverview, type DatabaseClient } from "../packages/db/src/index.ts";

const DEFAULT_REPOSITORY = "Snazzie/whitesmith";
const DEFAULT_WORKFLOW = "macos-smoke.yml";
const DEFAULT_REF = "main";
const POLL_INTERVAL_MS = 1_000;
const RUN_TIMEOUT_MS = 15 * 60_000;
const COMMAND_TIMEOUT_MS = 30_000;

export type GithubRunSummary = {
  id: number;
  event: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
};

type GithubJobSummary = {
  id: number;
  status: string;
  conclusion: string | null;
  runnerName: string | null;
};

export type FreshRunSnapshot = {
  githubStatus: string;
  githubConclusion: string | null;
  databaseRunStatus: string | null;
  databaseJobStatus: string | null;
  runnerName: string | null;
  leaseId: string | null;
  leaseState: string | null;
  pending: number;
};

export type FreshRunMilestones = {
  queued: boolean;
  lease: boolean;
  inProgress: boolean;
  terminal: boolean;
  reaped: boolean;
  pendingZero: boolean;
};
type ControlPlaneHealthResponse = {
  ok: boolean;
  buildId: string;
  startedAt: string;
  discovery: {
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    stale: boolean;
    staleAfterMs: number;
  };
};


type LiveOptions = {
  repository: string;
  workflow: string;
  ref: string;
  databaseUrl: string;
  tartExecutable: string;
  controlPlaneUrl: string;
  expectedBuildId: string;
};

type DatabaseRunState = {
  organizationId: string;
  runStatus: string | null;
  runConclusion: string | null;
  jobStatus: string | null;
  jobConclusion: string | null;
  runnerName: string | null;
  leaseId: string | null;
  leaseState: string | null;
  leaseCount: number;
  pending: number;
};

export function isWhitesmithRunnerName(value: string | null): boolean {
  return typeof value === "string" && /^whitesmith-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}
export function assertExpectedControlPlaneBuild(value: unknown, expectedBuildId: string): asserts value is ControlPlaneHealthResponse {
  if (!value || typeof value !== "object") throw new Error("control_plane_health_invalid");
  const health = value as Partial<ControlPlaneHealthResponse>;
  if (!health.discovery || typeof health.discovery !== "object") throw new Error("control_plane_health_invalid");
  if (health.discovery.stale || health.ok !== true) throw new Error("control_plane_discovery_stale");
  if (health.buildId !== expectedBuildId) throw new Error(`control_plane_build_mismatch: expected ${expectedBuildId}, received ${health.buildId ?? "unknown"}`);
}

async function verifyControlPlaneBuild(baseUrl: string, expectedBuildId: string): Promise<void> {
  const origin = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const response = await fetch(`${origin}/api/healthz`, { headers: { accept: "application/json" } });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("control_plane_health_invalid");
  }
  assertExpectedControlPlaneBuild(body, expectedBuildId);
}


export function selectFreshWorkflowRun(runs: GithubRunSummary[], baselineIds: ReadonlySet<number>): GithubRunSummary | undefined {
  return runs
    .filter((run) => run.event === "workflow_dispatch" && !baselineIds.has(run.id))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id - left.id)[0];
}

export function initialFreshRunMilestones(): FreshRunMilestones {
  return { queued: false, lease: false, inProgress: false, terminal: false, reaped: false, pendingZero: false };
}

export function advanceFreshRunMilestones(previous: FreshRunMilestones, snapshot: FreshRunSnapshot): FreshRunMilestones {
  const queued = previous.queued || (snapshot.databaseJobStatus === "queued" && snapshot.pending >= 1);
  const lease = previous.lease || (queued && snapshot.leaseId !== null);
  const inProgress = previous.inProgress || (lease && snapshot.githubStatus === "in_progress" && isWhitesmithRunnerName(snapshot.runnerName));
  const terminal = previous.terminal || (inProgress && snapshot.githubStatus === "completed" && snapshot.githubConclusion === "success" && snapshot.databaseRunStatus === "completed" && snapshot.databaseJobStatus === "completed");
  const reaped = previous.reaped || (terminal && snapshot.leaseState === "reaped");
  const pendingZero = previous.pendingZero || (reaped && snapshot.pending === 0);
  return { queued, lease, inProgress, terminal, reaped, pendingZero };
}

function delay(ms: number): Promise<void> {
  return Bun.sleep(ms);
}

async function runCommand(binary: string, args: string[]): Promise<string> {
  const child = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, COMMAND_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).finally(() => clearTimeout(timer));
  if (timedOut) throw new Error(`${binary}_timeout`);
  if (exitCode !== 0) throw new Error(`${binary}_failed: ${stderr.trim() || `exit ${exitCode}`}`);
  return stdout.trim();
}

async function ghJson<T>(path: string): Promise<T> {
  const output = await runCommand("gh", ["api", path]);
  try {
    return JSON.parse(output) as T;
  } catch {
    throw new Error("github_response_invalid");
  }
}

function parseRun(value: Record<string, unknown>): GithubRunSummary {
  const id = Number(value.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("github_run_invalid");
  return {
    id,
    event: typeof value.event === "string" ? value.event : "",
    status: typeof value.status === "string" ? value.status : "",
    conclusion: typeof value.conclusion === "string" ? value.conclusion : null,
    createdAt: typeof value.created_at === "string" ? value.created_at : "",
  };
}

async function listWorkflowRuns(repository: string, workflow: string, ref: string): Promise<GithubRunSummary[]> {
  const response = await ghJson<{ workflow_runs?: Array<Record<string, unknown>> }>(
    `repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?branch=${encodeURIComponent(ref)}&per_page=100`,
  );
  return (response.workflow_runs ?? []).map(parseRun);
}

async function getRun(repository: string, runId: number): Promise<GithubRunSummary> {
  return parseRun(await ghJson<Record<string, unknown>>(`repos/${repository}/actions/runs/${runId}`));
}

async function listRunJobs(repository: string, runId: number): Promise<GithubJobSummary[]> {
  const response = await ghJson<{ jobs?: Array<Record<string, unknown>> }>(
    `repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
  );
  return (response.jobs ?? []).map((value) => {
    const id = Number(value.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("github_job_invalid");
    return {
      id,
      status: typeof value.status === "string" ? value.status : "",
      conclusion: typeof value.conclusion === "string" ? value.conclusion : null,
      runnerName: typeof value.runner_name === "string" ? value.runner_name : null,
    };
  });
}

async function waitForExistingRun(repository: string, runId: number): Promise<void> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const [run, jobs] = await Promise.all([getRun(repository, runId), listRunJobs(repository, runId)]);
    const runnerNames = jobs.map((job) => job.runnerName);
    if (run.status !== "queued" && jobs.length > 0 && runnerNames.every(isWhitesmithRunnerName)) {
      console.log(JSON.stringify({ event: "baseline_run_assigned", runId, status: run.status, conclusion: run.conclusion, runnerNames }));
      return;
    }
    if (run.status === "completed") throw new Error(`baseline_run_${runId}_completed_without_whitesmith_runner`);
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`baseline_run_${runId}_timeout`);
}

async function waitForFreshRun(options: LiveOptions, baselineIds: ReadonlySet<number>): Promise<GithubRunSummary> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const fresh = selectFreshWorkflowRun(await listWorkflowRuns(options.repository, options.workflow, options.ref), baselineIds);
    if (fresh) {
      console.log(JSON.stringify({ event: "fresh_run_discovered", runId: fresh.id }));
      return fresh;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error("fresh_run_discovery_timeout");
}

async function repositoryOrganizationId(db: DatabaseClient, repository: string): Promise<string> {
  const rows = await db<Array<{ organizationId: string }>>`
    SELECT organization_id AS "organizationId"
    FROM dashboard_repositories
    WHERE full_name=${repository} AND available=true AND approved=true
  `;
  if (rows.length !== 1) throw new Error("approved_repository_not_unique");
  return rows[0].organizationId;
}

async function readDatabaseRunState(db: DatabaseClient, repository: string, organizationId: string, runId: number): Promise<DatabaseRunState> {
  const runRows = await db<Array<{ id: string; status: string; conclusion: string | null }>>`
    SELECT r.id,r.status,r.conclusion
    FROM dashboard_runs r
    JOIN dashboard_repositories repo ON repo.id=r.repository_id AND repo.organization_id=r.organization_id
    WHERE repo.full_name=${repository} AND r.github_run_id=${runId}
  `;
  const run = runRows[0];
  const jobs = run
    ? await db<Array<{ status: string; conclusion: string | null; runnerName: string | null }>>`
        SELECT status,conclusion,runner_name AS "runnerName"
        FROM dashboard_jobs
        WHERE run_id=${run.id}
        ORDER BY github_job_id
      `
    : [];
  if (jobs.length > 1) throw new Error("fresh_run_job_count_invalid");
  const leases = await db<Array<{ id: string; state: string }>>`
    SELECT l.id,l.state
    FROM runner_leases l
    JOIN dashboard_jobs j ON j.organization_id=l.organization_id AND j.github_job_id=l.github_job_id
    JOIN dashboard_runs r ON r.id=j.run_id
    JOIN dashboard_repositories repo ON repo.id=r.repository_id AND repo.organization_id=r.organization_id
    WHERE repo.full_name=${repository} AND r.github_run_id=${runId}
    ORDER BY l.created_at
  `;
  if (leases.length > 1) throw new Error("fresh_run_lease_count_invalid");
  const overview = await getOverview(db, organizationId, "24h");
  return {
    organizationId,
    runStatus: run?.status ?? null,
    runConclusion: run?.conclusion ?? null,
    jobStatus: jobs[0]?.status ?? null,
    jobConclusion: jobs[0]?.conclusion ?? null,
    runnerName: jobs[0]?.runnerName ?? null,
    leaseId: leases[0]?.id ?? null,
    leaseState: leases[0]?.state ?? null,
    leaseCount: leases.length,
    pending: overview.timeseries.at(-1)?.pending ?? -1,
  };
}

function milestoneChanges(previous: FreshRunMilestones, next: FreshRunMilestones): Array<keyof FreshRunMilestones> {
  return (Object.keys(next) as Array<keyof FreshRunMilestones>).filter((key) => !previous[key] && next[key]);
}

async function proveFreshRun(db: DatabaseClient, options: LiveOptions, organizationId: string, runId: number): Promise<{ milestones: FreshRunMilestones; leaseId: string }> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let milestones = initialFreshRunMilestones();
  let leaseId: string | null = null;
  while (Date.now() < deadline) {
    const [github, database] = await Promise.all([
      getRun(options.repository, runId),
      readDatabaseRunState(db, options.repository, organizationId, runId),
    ]);
    const snapshot: FreshRunSnapshot = {
      githubStatus: github.status,
      githubConclusion: github.conclusion,
      databaseRunStatus: database.runStatus,
      databaseJobStatus: database.jobStatus,
      runnerName: database.runnerName,
      leaseId: database.leaseId,
      leaseState: database.leaseState,
      pending: database.pending,
    };
    if (database.leaseId) leaseId = database.leaseId;
    const next = advanceFreshRunMilestones(milestones, snapshot);
    for (const milestone of milestoneChanges(milestones, next)) {
      console.log(JSON.stringify({ event: "fresh_run_milestone", runId, milestone, snapshot }));
    }
    milestones = next;
    if (github.status === "completed" && github.conclusion !== "success") throw new Error(`fresh_run_github_${github.conclusion ?? "unknown"}`);
    if (database.runStatus === "completed" && database.runConclusion !== "success") throw new Error(`fresh_run_database_${database.runConclusion ?? "unknown"}`);
    if (database.jobStatus === "completed" && database.jobConclusion !== "success") throw new Error(`fresh_job_database_${database.jobConclusion ?? "unknown"}`);
    if (database.leaseState === "failed") throw new Error("fresh_run_lease_failed");
    if (milestones.pendingZero) {
      if (!leaseId) throw new Error("fresh_run_lease_missing");
      return { milestones, leaseId };
    }
    if (github.status === "completed" && !milestones.inProgress) throw new Error("fresh_run_in_progress_not_observed");
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`fresh_run_${runId}_timeout`);
}

async function assertNoLeaseVms(tartExecutable: string): Promise<void> {
  const output = await runCommand(tartExecutable, ["list", "--format", "json"]);
  const entries = JSON.parse(output) as Array<{ Name?: unknown; name?: unknown }>;
  const names = entries.map((entry) => String(entry.Name ?? entry.name ?? "")).filter((name) => name.startsWith("whitesmith-job-"));
  if (names.length) throw new Error(`tart_lease_vms_remain: ${names.join(",")}`);
}

async function runLiveSmoke(): Promise<void> {
  if (Bun.env.WHITESMITH_LIVE_E2E !== "1") throw new Error("WHITESMITH_LIVE_E2E=1 is required");
  const options: LiveOptions = {
    repository: Bun.env.WHITESMITH_SMOKE_REPOSITORY ?? DEFAULT_REPOSITORY,
    workflow: Bun.env.WHITESMITH_SMOKE_WORKFLOW ?? DEFAULT_WORKFLOW,
    ref: Bun.env.WHITESMITH_SMOKE_REF ?? DEFAULT_REF,
    databaseUrl: Bun.env.DATABASE_URL ?? "",
    tartExecutable: Bun.env.WHITESMITH_TART_EXECUTABLE ?? "tart",
    controlPlaneUrl: Bun.env.WHITESMITH_CONTROL_PLANE_URL ?? Bun.env.PUBLIC_BASE_URL ?? "",
    expectedBuildId: Bun.env.WHITESMITH_EXPECTED_BUILD_ID ?? "",
  };
  if (!options.databaseUrl) throw new Error("DATABASE_URL is required");
  if (options.repository.split("/").length !== 2) throw new Error("WHITESMITH_SMOKE_REPOSITORY must be owner/repo");
  if (!options.controlPlaneUrl) throw new Error("WHITESMITH_CONTROL_PLANE_URL or PUBLIC_BASE_URL is required");
  if (!options.expectedBuildId) throw new Error("WHITESMITH_EXPECTED_BUILD_ID is required");
  await verifyControlPlaneBuild(options.controlPlaneUrl, options.expectedBuildId);
  await runCommand("gh", ["auth", "status", "--hostname", "github.com"]);
  const db = createDb(options.databaseUrl);
  try {
    const organizationId = await repositoryOrganizationId(db, options.repository);
    const baselineRuns = await listWorkflowRuns(options.repository, options.workflow, options.ref);
    const baselineIds = new Set(baselineRuns.map((run) => run.id));
    const queuedBaselineIds = baselineRuns.filter((run) => run.status === "queued").map((run) => run.id).sort((left, right) => left - right);
    console.log(JSON.stringify({ event: "baseline_recorded", queuedRunIds: queuedBaselineIds }));
    for (const runId of queuedBaselineIds) await waitForExistingRun(options.repository, runId);

    await runCommand("gh", ["workflow", "run", options.workflow, "--repo", options.repository, "--ref", options.ref]);
    console.log(JSON.stringify({ event: "fresh_run_dispatched", workflow: options.workflow, ref: options.ref }));
    const freshRun = await waitForFreshRun(options, baselineIds);
    const proof = await proveFreshRun(db, options, organizationId, freshRun.id);
    await assertNoLeaseVms(options.tartExecutable);
    console.log(JSON.stringify({ event: "live_job_pickup_passed", runId: freshRun.id, leaseId: proof.leaseId, milestones: proof.milestones }));
  } finally {
    await db.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  await runLiveSmoke();
}
