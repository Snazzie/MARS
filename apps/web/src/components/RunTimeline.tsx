import type { RunJob, RunStage } from "@whitesmith/contracts";

const stages: RunStage[] = ["queued", "allocating", "sandbox_ready", "agent_call_home", "runner_online", "running", "completed", "reaping", "reaped"];
const labels: Record<RunStage, string> = { queued: "Queued", allocating: "Allocating", sandbox_ready: "Sandbox ready", agent_call_home: "Agent call-home", runner_online: "Runner online", running: "Running", completed: "Completed", failed: "Failed", reaping: "Reaping", reaped: "Reaped" };

export function RunTimeline({ jobs }: { jobs: readonly RunJob[] }) {
  return <section className="timeline-panel" aria-labelledby="lifecycle-title"><div className="panel-kicker" id="lifecycle-title">Lifecycle</div><ol className="run-timeline">{stages.map((stage) => { const active = jobs.some((job) => job.stage === stage); const failed = jobs.some((job) => job.stage === "failed") && stage === "completed"; return <li className={`${active ? "is-active" : ""} ${failed ? "is-failed" : ""}`} key={stage}><span className="timeline-dot" aria-hidden="true" /><span>{labels[stage]}</span></li>; })}</ol><p className="timeline-note">Stage durations are recorded by the control plane; teardown remains visible after a result.</p></section>;
}
