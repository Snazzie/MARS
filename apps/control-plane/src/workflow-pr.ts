import YAML, { isMap, isScalar, isSeq, type Document, type YAMLMap } from "yaml";

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
    if (isScalar(runsOn) && (typeof runsOn.value === "string" || typeof runsOn.value === "number")) {
      jobs.push({ id, runsOn: String(runsOn.value), path: ["jobs", id, "runs-on"] });
    } else if (isSeq(runsOn) && runsOn.items.every((item) => isScalar(item) && typeof item.value === "string")) {
      jobs.push({ id, runsOn: runsOn.items.map((item) => String((item as { value: unknown }).value)), path: ["jobs", id, "runs-on"] });
    } else {
      throw new Error(`Unsupported workflow ${path}, job ${id}: runs-on must be a scalar or string sequence`);
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

export function previewWorkflowMutation(input: { files: readonly WorkflowFilePreview[]; selectedPaths: readonly string[]; labels: readonly string[] }): WorkflowMutation {
  const selected = input.selectedPaths.length ? [...input.selectedPaths] : input.files.map((file) => file.path);
  const known = new Set(input.files.map((file) => file.path));
  for (const path of selected) {
    if (!workflowPath.test(path)) throw new Error(`Invalid selected workflow path: ${path}`);
    if (!known.has(path)) throw new Error(`Selected workflow path not discovered: ${path}`);
  }
  const jobs = input.files.filter((file) => selected.includes(file.path)).flatMap((file) => file.jobs.map((job) => ({ ...job, path: file.path, proposedRunsOn: [...input.labels] })));
  if (!jobs.length) throw new Error("No selected job has runs-on; mutation would be a no-op");
  return { changedFiles: [...new Set(jobs.map((job) => job.path))], jobs, replacementCount: jobs.length, noOp: false };
}

export function applyWorkflowMutation(content: string, labels: readonly string[]): string {
  const { document, jobs } = parseWorkflow(".github/workflows/workflow.yml", content);
  if (!jobs.length) throw new Error("No workflow job has runs-on; mutation would be a no-op");
  if (!labels.length) throw new Error("Cannot replace runs-on with an empty label sequence");
  for (const job of jobs) document.setIn(job.path, [...labels]);
  return String(document);
}
