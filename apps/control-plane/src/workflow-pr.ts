import YAML, { isMap, isScalar, isSeq, type Document } from "yaml";
import { parseCurrentResourceLabels } from "@mars/db";

export interface WorkflowJobPreview {
  id: string;
  currentRunsOn: string | readonly string[];
}

export interface WorkflowFilePreview {
  path: string;
  jobs: WorkflowJobPreview[];
}

export interface WorkflowSelection {
  selectedPaths: readonly string[];
  selectedPath?: string;
  selectedJobId?: string;
  labels: readonly string[];
}

export interface WorkflowMutation {
  changedFiles: string[];
  jobs: Array<WorkflowJobPreview & { path: string; proposedRunsOn: readonly string[] }>;
  replacementCount: number;
  noOp: boolean;
}

const workflowPath = /^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/;
type JobData = { id: string; runsOn: string | readonly string[]; path: [string, string, "runs-on"] };

function parseWorkflow(path: string, content: string): { document: Document; jobs: JobData[] } {
  if (!workflowPath.test(path)) throw new Error(`Invalid workflow path: ${path}`);
  let document: Document;
  try {
    document = YAML.parseDocument(content, { prettyErrors: true });
    if (document.errors.length) throw document.errors[0];
  } catch (error) {
    throw new Error(`Malformed workflow ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = document.contents;
  if (!isMap(root)) throw new Error(`Unsupported workflow ${path}: root must be an object`);
  const jobsNode = root.get("jobs", true);
  if (!isMap(jobsNode)) throw new Error(`Unsupported workflow ${path}: jobs must be an object`);
  const jobs: JobData[] = [];
  for (const pair of jobsNode.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") throw new Error(`Unsupported workflow ${path}: job id must be a string`);
    const id = pair.key.value;
    if (!isMap(pair.value)) throw new Error(`Unsupported workflow ${path}, job ${id}: job must be an object`);
    const runsOn = pair.value.get("runs-on", true);
    if (runsOn === undefined) continue;
    if (isScalar(runsOn) && typeof runsOn.value === "string") {
      jobs.push({ id, runsOn: runsOn.value, path: ["jobs", id, "runs-on"] });
    } else if (isSeq(runsOn) && runsOn.items.every((item) => isScalar(item) && typeof item.value === "string")) {
      jobs.push({ id, runsOn: runsOn.items.map((item) => String((item as { value: unknown }).value)), path: ["jobs", id, "runs-on"] });
    } else {
      throw new Error(`Unsupported workflow ${path}, job ${id}: runs-on must be a string scalar or string sequence`);
    }
  }
  return { document, jobs };
}

export function discoverWorkflowFiles(files: readonly { path: string; content: string }[]): WorkflowFilePreview[] {
  return files.map(({ path, content }) => {
    const { jobs } = parseWorkflow(path, content);
    return { path, jobs: jobs.map(({ id, runsOn }) => ({ id, currentRunsOn: runsOn })) };
  });
}

function selectedPaths(input: WorkflowSelection): string[] {
  const hasPath = input.selectedPath !== undefined;
  const hasJob = input.selectedJobId !== undefined;
  if (hasPath !== hasJob) throw new Error("Focused workflow selection requires selectedPath and selectedJobId");
  if (hasPath && hasJob) {
    if (input.selectedPaths.length && !input.selectedPaths.includes(input.selectedPath!)) {
      throw new Error("selectedPath must be included in selectedPaths");
    }
    return [input.selectedPath!];
  }
  return input.selectedPaths.length ? [...input.selectedPaths] : [];
}

function focusedLabels(labels: readonly string[]): string[] {
  if (!labels.length) throw new Error("Cannot replace selected workflows: labels cannot be empty");
  return labels.map((label) => {
    const value = label.trim();
    const routingLabel = parseCurrentResourceLabels([value]).windowsLabel;
    if (routingLabel) return value;
    const match = /^(\d+)(VCPU|G)$/i.exec(value);
    if (!match) throw new Error(`Invalid focused resource label: ${label}`);
    const amount = Number(match[1]);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`Invalid resource label: ${label}`);
    return `${amount}${match[2].toUpperCase()}`;
  });
}

function runsOnValues(value: string | readonly string[]): string[] {
  return typeof value === "string" ? [value] : [...value];
}

function proposedLabels(currentRunsOn: string | readonly string[], labels: readonly string[], focused: boolean): string[] {
  const normalized = focused ? focusedLabels(labels) : [...labels];
  if (!focused) return normalized;
  const currentWindowsLabel = parseCurrentResourceLabels(runsOnValues(currentRunsOn)).windowsLabel;
  if (!currentWindowsLabel || normalized.some((label) => label.toLowerCase() === currentWindowsLabel.toLowerCase())) return normalized;
  return [currentWindowsLabel, ...normalized];
}

export function previewWorkflowMutation(input: WorkflowSelection & { files: readonly WorkflowFilePreview[] }): WorkflowMutation {
  const selected = selectedPaths(input);
  const paths = selected.length ? selected : input.files.map((file) => file.path);
  const known = new Set(input.files.map((file) => file.path));
  const focused = input.selectedPath !== undefined;
  for (const path of paths) {
    if (!workflowPath.test(path)) throw new Error(`Invalid selected workflow path: ${path}`);
    if (!known.has(path)) throw new Error(`Selected workflow path not discovered: ${path}`);
  }
  if (!input.labels.length) throw new Error(`Cannot replace selected workflows (${paths.join(", ")}): labels cannot be empty`);
  const jobs = input.files
    .filter((file) => paths.includes(file.path))
    .flatMap((file) => file.jobs
      .filter((job) => !input.selectedJobId || job.id === input.selectedJobId)
      .map((job) => ({ ...job, path: file.path, proposedRunsOn: proposedLabels(job.currentRunsOn, input.labels, focused) })));
  if (!jobs.length) {
    const target = input.selectedJobId ? `job ${input.selectedJobId}` : "job";
    throw new Error(`No selected ${target} has runs-on in ${paths.join(", ")}; mutation would be a no-op`);
  }
  const changed = jobs.filter((job) => JSON.stringify(runsOnValues(job.currentRunsOn)) !== JSON.stringify(job.proposedRunsOn));
  return {
    changedFiles: [...new Set(changed.map((job) => job.path))],
    jobs,
    replacementCount: changed.length,
    noOp: changed.length === 0,
  };
}

export function applyWorkflowMutation(content: string, labels: readonly string[], selectedJobId?: string, preserveWindowsRouting = Boolean(selectedJobId)): string {
  const { document, jobs } = parseWorkflow(".github/workflows/workflow.yml", content);
  const selected = jobs.filter((job) => !selectedJobId || job.id === selectedJobId);
  if (!selected.length) throw new Error(`No selected job has runs-on; mutation would be a no-op`);
  for (const job of selected) document.setIn(job.path, proposedLabels(job.runsOn, labels, preserveWindowsRouting));
  return String(document);
}
