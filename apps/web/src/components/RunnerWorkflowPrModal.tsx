import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { JobLabelRecommendation } from "@mars/contracts";
import { createRunnerWorkflowPr, getRunnerWorkflowFiles, previewRunnerWorkflowPr } from "../api.ts";

type FocusedRecommendation = Partial<Pick<JobLabelRecommendation, "currentWindowsLabel" | "currentLabels" | "recommendedVcpu" | "recommendedMemoryGiB" | "p95CpuPeakPercent" | "p95MemoryPeakBytes" | "successfulRunCount">> & {
  labels?: readonly string[];
};

export type RunnerWorkflowPrModalProps = {
  organizationId: string;
  repositoryId: string;
  repositoryName: string;
  workflowName?: string;
  jobName?: string;
  open: boolean;
  onClose: () => void;
  onCreated?: (url: string) => void;
  selectedPath?: string | null;
  selectedJobId?: string | null;
  labels?: readonly string[];
  currentLabels?: readonly string[];
  recommendation?: FocusedRecommendation | null;
  p95CpuPeakPercent?: number | null;
  p95MemoryPeakBytes?: number | null;
  successfulRunCount?: number;
};

export const isRunnerWorkflowPrDisabled = (input: {
  result: string | null;
  hasPreview: boolean;
  noOp?: boolean;
  replacementCount?: number;
  previewLoading?: boolean;
  filesLoading?: boolean;
  submitting?: boolean;
  confirmed?: boolean;
  labelsValid?: boolean;
  focusedPreviewMatches?: boolean;
}) => Boolean(input.result)
  || !input.hasPreview
  || Boolean(input.noOp)
  || input.replacementCount === 0
  || !input.confirmed
  || input.labelsValid === false
  || input.focusedPreviewMatches === false
  || Boolean(input.previewLoading || input.filesLoading || input.submitting);

export const handleRunnerWorkflowEscape = (event: KeyboardEvent, onClose: () => void) => { if (event.key === "Escape") onClose(); };
export const formatRunnerWorkflowRunsOn = (value: string | string[]) => Array.isArray(value) ? value.join(", ") : value;

function isWindowsRoutingLabel(value: string): boolean {
  return /^(?:mars-)?windows(?:[-_][a-z0-9._-]+)*$/i.test(value);
}

export function areRunnerWorkflowLabelsValid(labels: readonly string[], expectedCurrentLabels?: readonly string[]): boolean {
  const values = labels.map((label) => label.trim());
  if (!values.length || values.some((value) => !value)) return false;
  const normalized = values.map((value) => value.toLowerCase());
  if (new Set(normalized).size !== values.length) return false;
  const routes = values.filter(isWindowsRoutingLabel);
  if (routes.length !== 1) return false;
  const counts = { VCPU: 0, G: 0 };
  for (const value of values) {
    if (isWindowsRoutingLabel(value)) continue;
    const match = /^(\d+)(VCPU|G)$/i.exec(value);
    if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) <= 0) {
      const expected = expectedCurrentLabels?.map((label) => label.trim().toLowerCase()) ?? [];
      if (!expected.includes(value.toLowerCase())) return false;
      continue;
    }
    const kind = match[2].toUpperCase() as "VCPU" | "G";
    counts[kind] += 1;
    if (counts[kind] > 1) return false;
  }
  if (expectedCurrentLabels?.length) {
    const expected = expectedCurrentLabels.map((label) => label.trim());
    if (expected.some((label) => !label) || new Set(expected.map((label) => label.toLowerCase())).size !== expected.length) return false;
    const currentRoute = expected.filter(isWindowsRoutingLabel);
    if (currentRoute.length !== 1 || currentRoute[0].toLowerCase() !== routes[0].toLowerCase()) return false;
    for (const label of expected) {
      if (isWindowsRoutingLabel(label)) continue;
      const match = /^(\d+)(VCPU|G)$/i.exec(label);
      if (match && (!Number.isSafeInteger(Number(match[1])) || Number(match[1]) <= 0)) return false;
    }
    const currentCustom = expected.filter((label) => !isWindowsRoutingLabel(label) && !/^(\d+)(VCPU|G)$/i.test(label)).map((label) => label.toLowerCase());
    const requestedCustom = values.filter((label) => !isWindowsRoutingLabel(label) && !/^(\d+)(VCPU|G)$/i.test(label)).map((label) => label.toLowerCase());
    if (currentCustom.length !== requestedCustom.length || currentCustom.some((label) => !requestedCustom.includes(label))) return false;
  }
  return true;
}

function labelsFromRecommendation(recommendation: FocusedRecommendation | null | undefined): string[] {
  if (recommendation?.labels?.length) return recommendation.labels.map((label) => label.trim()).filter(Boolean);
  if (recommendation?.currentLabels?.length) return recommendation.currentLabels.map((label) => label.trim()).filter(Boolean);
  if (!recommendation) return [];
  const labels = recommendation.currentWindowsLabel ? [recommendation.currentWindowsLabel] : [];
  if (recommendation.recommendedVcpu !== null && recommendation.recommendedVcpu !== undefined) labels.push(`${recommendation.recommendedVcpu}VCPU`);
  if (recommendation.recommendedMemoryGiB !== null && recommendation.recommendedMemoryGiB !== undefined) labels.push(`${recommendation.recommendedMemoryGiB}G`);
  return labels;
}

export function RunnerWorkflowPrModal({
  organizationId,
  repositoryId,
  repositoryName,
  workflowName,
  jobName,
  open,
  onClose,
  onCreated,
  selectedPath = null,
  selectedJobId = null,
  labels,
  currentLabels,
  recommendation = null,
  p95CpuPeakPercent,
  p95MemoryPeakBytes,
  successfulRunCount,
}: RunnerWorkflowPrModalProps) {
  const focused = Boolean(selectedPath || selectedJobId);
  const focusedInputReady = Boolean(selectedPath && selectedJobId);
  const focusedKey = `${selectedPath ?? ""}:${selectedJobId ?? ""}`;
  const initialLabels = useMemo(
    () => labels !== undefined ? labels.map((label) => label.trim()).filter(Boolean) : labelsFromRecommendation(recommendation),
    [labels, recommendation],
  );
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const initialLabelsKey = useRef("");
  const files = useQuery({
    queryKey: ["runner-workflows", organizationId, repositoryId],
    queryFn: () => getRunnerWorkflowFiles(organizationId, repositoryId),
    enabled: open && !focused && Boolean(organizationId && repositoryId),
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [editableLabels, setEditableLabels] = useState<string[]>(initialLabels);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    const onKeyDown = (event: KeyboardEvent) => {
      handleRunnerWorkflowEscape(event, onClose);
      if (event.key !== "Tab") return;
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>("button, input, textarea, select, [tabindex]:not([tabindex='-1'])");
      if (!controls?.length) return;
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    requestAnimationFrame(() => dialogRef.current?.focus());
    return () => { document.removeEventListener("keydown", onKeyDown); previousFocus.current?.focus(); };
  }, [open, onClose]);

  useEffect(() => {
    if (files.data && !focused) {
      setSelected(files.data.map((file) => file.path));
      setConfirmed(false);
    }
  }, [files.data, focused]);
  useEffect(() => {
    if (!focused) {
      setEditableLabels([]);
      initialLabelsKey.current = "";
      return;
    }
    const nextKey = `${focusedKey}|${initialLabels.join("\u0000")}`;
    if (initialLabelsKey.current !== nextKey) {
      setEditableLabels(initialLabels);
      initialLabelsKey.current = nextKey;
      setConfirmed(false);
    }
  }, [focused, focusedKey, initialLabels]);
  useEffect(() => { setConfirmed(false); }, [selected, editableLabels]);

  const previewInput = focused
    ? { selectedPath: selectedPath!, selectedJobId: selectedJobId!, labels: editableLabels }
    : selected;
  const preview = useQuery({
    queryKey: focused
      ? ["runner-workflow-preview", organizationId, repositoryId, selectedPath, selectedJobId, editableLabels]
      : ["runner-workflow-preview", organizationId, repositoryId, selected],
    queryFn: () => previewRunnerWorkflowPr(organizationId, repositoryId, previewInput),
    enabled: open && (focused ? focusedInputReady && editableLabels.length > 0 : Boolean(files.data) && selected.length > 0),
  });
  const create = useMutation({
    mutationFn: (input: { expectedHeadSha: string }) => {
      const cpu = p95CpuPeakPercent ?? recommendation?.p95CpuPeakPercent;
      const memory = p95MemoryPeakBytes ?? recommendation?.p95MemoryPeakBytes;
      const samples = successfulRunCount ?? recommendation?.successfulRunCount;
      const metadata = {
        ...(typeof cpu === "number" ? { p95CpuPeakPercent: cpu } : {}),
        ...(typeof memory === "number" ? { p95MemoryPeakBytes: memory } : {}),
        ...(typeof samples === "number" ? { successfulRunCount: samples } : {}),
      };
      return createRunnerWorkflowPr(organizationId, repositoryId, {
        ...(focused
          ? { selectedPath: selectedPath!, selectedJobId: selectedJobId!, labels: editableLabels }
          : { selectedPaths: selected }),
        expectedHeadSha: input.expectedHeadSha,
        ...metadata,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(body.trim() ? { body: body.trim() } : {}),
      });
    },
    onSuccess: (value) => { setResult(value.url); onCreated?.(value.url); },
  });
  const error = files.error ?? preview.error ?? create.error;
  const jobs = useMemo(() => {
    const allJobs = preview.data?.jobs ?? [];
    if (!focused || !selectedPath || !selectedJobId) return allJobs;
    return allJobs.filter((job) => job.path === selectedPath && job.id === selectedJobId);
  }, [focused, preview.data, selectedJobId, selectedPath]);
  if (!open) return null;
  const labelsValid = !focused || areRunnerWorkflowLabelsValid(editableLabels, currentLabels);
  const focusedPreviewMatches = !focused || (focusedInputReady && jobs.length === 1);
  const invalid = isRunnerWorkflowPrDisabled({
    result,
    hasPreview: Boolean(preview.data),
    noOp: preview.data?.noOp,
    replacementCount: preview.data?.replacementCount,
    previewLoading: preview.isFetching,
    filesLoading: files.isLoading,
    submitting: create.isPending,
    confirmed,
    labelsValid,
    focusedPreviewMatches,
  });
  return <div className="modal-backdrop" role="presentation"><section ref={dialogRef} tabIndex={-1} className="runner-workflow-modal" role="dialog" aria-modal="true" aria-labelledby="runner-workflow-title">
    <header className="modal-header"><div><p className="eyebrow">Workflow migration</p><h2 id="runner-workflow-title">Use Mars runners</h2><p>{repositoryName}{workflowName && jobName ? ` · ${workflowName} / ${jobName}` : ""}</p></div><button type="button" className="control-button control-button-secondary" aria-label="Close dialog" onClick={onClose}>Close</button></header>
    {error && <div role="alert" className="form-error">{error instanceof Error ? error.message : "Could not load workflow preview."}<button type="button" className="control-button" onClick={() => { create.reset(); void (files.error ? files.refetch() : preview.refetch()); }}>Refresh preview</button></div>}
    {files.isLoading && !focused && <p role="status">Loading workflow files…</p>}
    {files.data && !focused && <fieldset className="workflow-file-selection"><legend>Workflow files</legend>{files.data.length === 0 && <p>No eligible workflow files found.</p>}{files.data.map((file) => <label key={file.path}><input type="checkbox" checked={selected.includes(file.path)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, file.path] : current.filter((path) => path !== file.path))} /> <code>{file.path}</code></label>)}</fieldset>}
    {preview.isFetching && <p role="status" aria-live="polite">Refreshing preview…</p>}{preview.data && <div className="workflow-job-list" aria-live="polite"><h3>Runner changes</h3>{jobs.length === 0 ? <p>No jobs with runs-on values are selected.</p> : jobs.map((job) => <article key={`${job.path}:${job.id}`}><strong>{job.id}</strong><small>{job.path}</small><p><code>{formatRunnerWorkflowRunsOn(job.currentRunsOn)}</code> → <code>{job.proposedRunsOn.join(", ")}</code></p></article>)}</div>}
    {focused && <div className="workflow-focused-selection"><p>Selected job <strong>{selectedJobId}</strong></p><small>{selectedPath}</small><label>Runner labels<input name="labels" aria-label="Runner labels" value={editableLabels.join(", ")} aria-invalid={!labelsValid} onChange={(event) => setEditableLabels(event.target.value.split(",").map((label) => label.trim()).filter(Boolean))} /></label>{!labelsValid && <p role="status">Enter a Windows routing label and positive integer VCPU/G labels.</p>}</div>}
    <label>PR title<input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} /></label>
    <label>PR description<textarea value={body} maxLength={10000} onChange={(event) => setBody(event.target.value)} /></label>
    <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I confirm the selected workflow replacements.</label>
    {result && <p role="status" aria-live="polite">Pull request created. <a href={result} target="_blank" rel="noreferrer">Open pull request</a></p>}
    <footer className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button type="button" className="button" disabled={invalid} onClick={() => preview.data && create.mutate({ expectedHeadSha: preview.data.headSha })}>{create.isPending ? "Creating…" : "Create PR"}</button></footer>
  </section></div>;
}
