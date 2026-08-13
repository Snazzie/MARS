import type { GithubStepSnapshot } from "./runs.ts";

export type AttributedGithubJobLog = {
  steps: Map<number, string>;
  unattributed: string;
};

const timestampPrefix = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/;
const terminalSequence = /\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~])/g;
const unsafeControl = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

function cleanLogLine(value: string): string {
  return value.replace(terminalSequence, "").replace(unsafeControl, "");
}

export function attributeGithubJobLog(text: string, steps: readonly GithubStepSnapshot[]): AttributedGithubJobLog {
  const intervals = steps
    .filter((step): step is GithubStepSnapshot & { startedAt: string; completedAt: string } => Boolean(step.startedAt && step.completedAt))
    .map(step => ({ step, start: Date.parse(step.startedAt), end: Date.parse(step.completedAt) }))
    .filter(({ start, end }) => Number.isFinite(start) && Number.isFinite(end) && end >= start)
    .sort((left, right) => left.start - right.start || left.step.number - right.step.number);
  const activeSteps = [...steps].filter(step => step.conclusion !== "skipped").sort((left, right) => left.number - right.number);
  const setupStep = activeSteps.find(step => step.name === "Set up job");
  const completeStep = activeSteps.find(step => step.name === "Complete job");
  const regularSteps = activeSteps.filter(step => step !== setupStep && step !== completeStep && !step.name.startsWith("Post "));
  const postSteps = activeSteps.filter(step => step.name.startsWith("Post "));
  const attributed = new Map<number, string[]>();
  const unattributed: string[] = [];
  const destinationFor = (number: number | undefined): string[] => {
    if (number === undefined) return unattributed;
    const existing = attributed.get(number);
    if (existing) return existing;
    const created: string[] = [];
    attributed.set(number, created);
    return created;
  };
  let destination = destinationFor(setupStep?.number);
  let markerMode = false;
  let regularIndex = 0;
  let postIndex = 0;
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();

  for (const rawLine of lines) {
    const line = cleanLogLine(rawLine);
    const match = line.match(timestampPrefix);
    const message = match ? line.slice(match[0].length) : line;
    if (message.startsWith("##[group]Run ")) {
      destination = destinationFor(regularSteps[regularIndex]?.number);
      regularIndex += 1;
      markerMode = true;
    } else if (message === "Post job cleanup.") {
      destination = destinationFor(postSteps[postIndex]?.number);
      postIndex += 1;
      markerMode = true;
    } else if (message.startsWith("Cleaning up orphan processes")) {
      destination = destinationFor(completeStep?.number);
      markerMode = true;
    } else if (match && !markerMode && !setupStep) {
      const occurredAt = Date.parse(match[1]!);
      const interval = Number.isFinite(occurredAt)
        ? intervals.find(({ start, end }) => occurredAt >= start && occurredAt <= end)
        : undefined;
      destination = destinationFor(interval?.step.number);
    }
    destination.push(`${line}\n`);
  }

  return {
    steps: new Map([...attributed].map(([number, linesForStep]) => [number, linesForStep.join("")])),
    unattributed: unattributed.join(""),
  };
}
