import type { RunJob, RunStage } from "@mars/contracts";

const stages: RunStage[] = ["queued", "allocating", "sandbox_ready", "agent_call_home", "runner_online", "running", "completed", "reaping", "reaped"];
const labels: Record<RunStage, string> = { queued: "Queued", allocating: "Allocating", sandbox_ready: "Sandbox ready", agent_call_home: "Agent call-home", runner_online: "Runner online", running: "Running", completed: "Completed", failed: "Failed", reaping: "Reaping", reaped: "Reaped" };

type StageDuration = Partial<Record<RunStage, number>>;
export function RunTimeline({ jobs, durations }: { jobs: readonly RunJob[]; durations?: StageDuration }) {
  return <section className="timeline-panel" aria-labelledby="lifecycle-title"><div className="panel-kicker" id="lifecycle-title">Lifecycle</div><ol className="run-timeline">{stages.map((stage) => { const active = jobs.some((job) => job.stage === stage); const failed = jobs.some((job) => job.stage === "failed") && stage === "completed"; const duration = durations?.[stage]; return <li className={`${active ? "is-active" : ""} ${failed ? "is-failed" : ""}`} key={stage}><span className="timeline-dot" aria-hidden="true" /><span>{labels[stage]}{duration !== undefined ? <small className="timeline-duration">{duration < 1000 ? `${duration}ms` : `${Math.round(duration / 1000)}s`}</small> : null}</span></li>; })}</ol><p className="timeline-note">Durations appear when the control plane records stage boundaries; teardown remains visible after a result.</p></section>;
}
