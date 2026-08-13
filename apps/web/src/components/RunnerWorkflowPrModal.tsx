import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createRunnerWorkflowPr, getRunnerWorkflowFiles, previewRunnerWorkflowPr } from "../api.ts";
export const isRunnerWorkflowPrDisabled = (input: { result: string | null; hasPreview: boolean; noOp?: boolean; replacementCount?: number; previewLoading?: boolean; filesLoading?: boolean; submitting?: boolean }) => Boolean(input.result) || !input.hasPreview || Boolean(input.noOp) || input.replacementCount === 0 || Boolean(input.previewLoading || input.filesLoading || input.submitting);
export const handleRunnerWorkflowEscape = (event: KeyboardEvent, onClose: () => void) => { if (event.key === "Escape") onClose(); };
export const formatRunnerWorkflowRunsOn = (value: string | string[]) => Array.isArray(value) ? value.join(", ") : value;
type Props = { organizationId: string; repositoryId: string; repositoryName: string; open: boolean; onClose: () => void; onCreated?: (url: string) => void };
export function RunnerWorkflowPrModal({ organizationId, repositoryId, repositoryName, open, onClose, onCreated }: Props) {
  const dialogRef = useRef<HTMLElement>(null); const previousFocus = useRef<HTMLElement | null>(null);
  const files = useQuery({ queryKey: ["runner-workflows", organizationId, repositoryId], queryFn: () => getRunnerWorkflowFiles(organizationId, repositoryId), enabled: open && Boolean(organizationId && repositoryId) });
  const [selected, setSelected] = useState<string[]>([]); const [title, setTitle] = useState(""); const [body, setBody] = useState(""); const [result, setResult] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    const onKeyDown = (event: KeyboardEvent) => handleRunnerWorkflowEscape(event, onClose);
    document.addEventListener("keydown", onKeyDown);
    requestAnimationFrame(() => dialogRef.current?.focus());
    return () => { document.removeEventListener("keydown", onKeyDown); previousFocus.current?.focus(); };
  }, [open, onClose]);
  useEffect(() => { if (files.data) setSelected(files.data.map((f) => f.path)); }, [files.data]);
  const preview = useQuery({ queryKey: ["runner-workflow-preview", organizationId, repositoryId, selected], queryFn: () => previewRunnerWorkflowPr(organizationId, repositoryId, selected), enabled: open && Boolean(files.data) && selected.length > 0 });
  const create = useMutation({ mutationFn: (input: { expectedHeadSha: string }) => createRunnerWorkflowPr(organizationId, repositoryId, { selectedPaths: selected, expectedHeadSha: input.expectedHeadSha, ...(title.trim() ? { title: title.trim() } : {}), ...(body.trim() ? { body: body.trim() } : {}) }), onSuccess: (value) => { setResult(value.url); onCreated?.(value.url); } });
  const error = files.error ?? preview.error ?? create.error; const jobs = useMemo(() => preview.data?.jobs ?? [], [preview.data]);
  if (!open) return null;
  const invalid = isRunnerWorkflowPrDisabled({ result, hasPreview: Boolean(preview.data), noOp: preview.data?.noOp, replacementCount: preview.data?.replacementCount, previewLoading: preview.isFetching, filesLoading: files.isLoading, submitting: create.isPending });
  return <div className="modal-backdrop" role="presentation"><section ref={dialogRef} tabIndex={-1} className="runner-workflow-modal" role="dialog" aria-modal="true" aria-labelledby="runner-workflow-title">
    <header className="modal-header"><div><p className="eyebrow">Workflow migration</p><h2 id="runner-workflow-title">Use Whitesmith runners</h2><p>{repositoryName}</p></div><button type="button" className="control-button control-button-secondary" aria-label="Close dialog" onClick={onClose}>Close</button></header>
    {error && <div role="alert" className="form-error">{error instanceof Error ? error.message : "Could not load workflow preview."}<button type="button" className="control-button" onClick={() => void (files.error ? files.refetch() : preview.refetch())}>Refresh preview</button></div>}
    {files.isLoading && <p role="status">Loading workflow files…</p>}
    {files.data && <><fieldset className="workflow-file-selection"><legend>Workflow files</legend>{files.data.length === 0 && <p>No eligible workflow files found.</p>}{files.data.map((file) => <label key={file.path}><input type="checkbox" checked={selected.includes(file.path)} onChange={(e) => setSelected((current) => e.target.checked ? [...current, file.path] : current.filter((path) => path !== file.path))} /> <code>{file.path}</code></label>)}</fieldset>
      {preview.isFetching && <p role="status" aria-live="polite">Refreshing preview…</p>}{preview.data && <div className="workflow-job-list" aria-live="polite"><h3>Runner changes</h3>{jobs.length === 0 ? <p>No jobs with runs-on values are selected.</p> : jobs.map((job) => <article key={`${job.path}:${job.id}`}><strong>{job.id}</strong><small>{job.path}</small><p><code>{formatRunnerWorkflowRunsOn(job.currentRunsOn)}</code> → <code>{job.proposedRunsOn.join(", ")}</code></p></article>)}</div>}
      <label>PR title<input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></label><label>PR description<textarea value={body} maxLength={10000} onChange={(e) => setBody(e.target.value)} /></label>{result && <p role="status" aria-live="polite">Pull request created. <a href={result} target="_blank" rel="noreferrer">Open pull request</a></p>}
      <footer className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button type="button" className="button" disabled={invalid} onClick={() => preview.data && create.mutate({ expectedHeadSha: preview.data.headSha })}>{create.isPending ? "Creating…" : "Create PR"}</button></footer></>}
  </section></div>;
}
