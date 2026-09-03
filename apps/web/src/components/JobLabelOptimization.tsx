import type { JobLabelRecommendation } from "@mars/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { getJobLabelRecommendation } from "../api.ts";
import { formatBytes, formatPercent } from "../routes/timing-model.ts";

export type JobLabelRecommendationRequest = {
  from: string;
  to: string;
  repositoryId: string;
  workflowName: string;
  jobName: string;
};
export type JobLabelOptimizationRange = Pick<JobLabelRecommendationRequest, "from" | "to">;

export type JobLabelOptimizationRequest = {
  selectedPath: string;
  selectedJobId: string;
  labels: string[];
  p95CpuPeakPercent: number | null;
  p95MemoryPeakBytes: number | null;
  successfulRunCount: number;
};

export type JobLabelOptimizationProps = {
  organizationId: string;
  activeRange: JobLabelOptimizationRange;
  repositoryId: string | null;
  repositoryName: string | null;
  workflowName: string;
  jobName: string;
  selectedPath?: string | null;
  selectedJobId?: string | null;
  currentLabels?: readonly string[];
  currentVcpu?: number | null;
  currentMemoryGiB?: number | null;
  onRequestPullRequest?: (request: JobLabelOptimizationRequest) => void;
  onCreatePullRequest?: (request: JobLabelOptimizationRequest) => void;
};

export function isPositiveIntegerLabel(value: string): boolean {
  if (!/^[1-9]\d*$/.test(value)) return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0;
}

function labelNumber(labels: readonly string[], pattern: RegExp): number | null {
  const label = labels.find((value) => pattern.test(value));
  if (!label) return null;
  const value = Number(label.match(pattern)?.[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function unavailableReason(reason: string | null): string {
  switch (reason) {
    case "insufficient_history":
      return "At least five successful runs are required before labels can be recommended.";
    case "insufficient_telemetry_coverage":
      return "At least 80% CPU and memory telemetry coverage is required before labels can be recommended.";
    case "missing_resource_telemetry":
      return "CPU and memory telemetry are not available for a safe recommendation.";
    case "missing_cpu_telemetry":
      return "CPU telemetry is not available for a safe recommendation.";
    case "missing_memory_telemetry":
      return "Memory telemetry is not available for a safe recommendation.";
    default:
      return "There is not enough reliable resource history to recommend labels yet.";
  }
}

function currentLabelsFor(
  recommendation: JobLabelRecommendation,
  labels: readonly string[] | undefined,
  currentVcpu: number | null | undefined,
  currentMemoryGiB: number | null | undefined,
): string[] {
  const routeLabel = recommendation.currentWindowsLabel;
  const existing = labels?.length ? [...labels] : [];
  const vcpu = labelNumber(existing, /^(\d+)VCPU$/i) ?? currentVcpu ?? recommendation.recommendedVcpu;
  const memoryGiB = labelNumber(existing, /^(\d+)G$/i) ?? currentMemoryGiB ?? recommendation.recommendedMemoryGiB;
  const numeric = existing.filter((label) => !/^\d+(?:VCPU|G)$/i.test(label));
  if (routeLabel && !numeric.includes(routeLabel)) numeric.unshift(routeLabel);
  if (vcpu !== null && vcpu !== undefined) numeric.push(`${vcpu}VCPU`);
  if (memoryGiB !== null && memoryGiB !== undefined) numeric.push(`${memoryGiB}G`);
  return numeric;
}

function proposedLabels(currentLabels: readonly string[], vcpu: string, memoryGiB: string): string[] {
  const withoutNumeric = currentLabels.filter((label) => !/^\d+(?:VCPU|G)$/i.test(label));
  return [...withoutNumeric, `${vcpu}VCPU`, `${memoryGiB}G`];
}

function sameLabels(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((label, index) => label === right[index]);
}

export function JobLabelOptimization({
  organizationId,
  activeRange,
  repositoryId,
  repositoryName,
  workflowName,
  jobName,
  selectedPath = null,
  selectedJobId = null,
  currentLabels,
  currentVcpu,
  currentMemoryGiB,
  onRequestPullRequest,
  onCreatePullRequest,
}: JobLabelOptimizationProps) {
  const request = useMemo<JobLabelRecommendationRequest>(() => ({
    ...activeRange,
    repositoryId: repositoryId ?? "",
    workflowName,
    jobName,
  }), [activeRange, jobName, repositoryId, workflowName]);
  const query = useQuery({
    queryKey: ["org", organizationId, "job-label-recommendation", request] as const,
    queryFn: () => getJobLabelRecommendation(organizationId, request),
    enabled: Boolean(organizationId && repositoryId && workflowName && jobName && activeRange.from && activeRange.to),
  });
  const recommendation = query.data;
  const current = useMemo(
    () => recommendation ? currentLabelsFor(recommendation, currentLabels, currentVcpu, currentMemoryGiB) : [],
    [currentLabels, currentMemoryGiB, currentVcpu, recommendation],
  );
  const [vcpuValue, setVcpuValue] = useState<string | null>(null);
  const [memoryValue, setMemoryValue] = useState<string | null>(null);
  useEffect(() => {
    setVcpuValue(recommendation?.recommendedVcpu === null || recommendation?.recommendedVcpu === undefined ? null : String(recommendation.recommendedVcpu));
    setMemoryValue(recommendation?.recommendedMemoryGiB === null || recommendation?.recommendedMemoryGiB === undefined ? null : String(recommendation.recommendedMemoryGiB));
  }, [recommendation]);

  const vcpu = vcpuValue ?? (recommendation?.recommendedVcpu === null || recommendation?.recommendedVcpu === undefined ? "" : String(recommendation.recommendedVcpu));
  const memoryGiB = memoryValue ?? (recommendation?.recommendedMemoryGiB === null || recommendation?.recommendedMemoryGiB === undefined ? "" : String(recommendation.recommendedMemoryGiB));
  const validValues = isPositiveIntegerLabel(vcpu) && isPositiveIntegerLabel(memoryGiB);
  const proposed = recommendation && validValues ? proposedLabels(current, vcpu, memoryGiB) : [];
  const noOp = proposed.length > 0 && sameLabels(current, proposed);
  const hasRecommendation = recommendation?.status === "available" && recommendation.currentWindowsLabel !== null && recommendation.recommendedVcpu !== null && recommendation.recommendedMemoryGiB !== null;
  const hasRepositoryMetadata = Boolean(organizationId && repositoryId && repositoryName && workflowName && jobName && selectedPath && selectedJobId);
  const canRequestPullRequest = Boolean(hasRecommendation && hasRepositoryMetadata && validValues && !noOp && (onRequestPullRequest || onCreatePullRequest));
  const requestPullRequest = onRequestPullRequest ?? onCreatePullRequest;
  const invalidMessage = !validValues ? "Enter positive whole numbers for VCPU and G labels." : noOp ? "The proposed labels are unchanged; there is no pull request to create." : null;

  return (
    <section className="job-label-optimization" aria-labelledby="job-label-optimization-title">
      <header className="job-label-optimization-header">
        <div>
          <p className="eyebrow">Resource guidance</p>
          <h3 id="job-label-optimization-title">Optimize runner labels</h3>
        </div>
        <p className="job-label-optimization-caption">Recommendations use sampled successful-run telemetry and are not guarantees.</p>
      </header>
      {query.isLoading && <p className="job-label-optimization-status" role="status" aria-live="polite">Loading label recommendation…</p>}
      {query.error && <p className="job-label-optimization-status is-error" role="alert">Label recommendation could not be loaded. {query.error instanceof Error ? query.error.message : "Try again later."}</p>}
      {!query.isLoading && !query.error && recommendation?.status === "unavailable" && (
        <p className="job-label-optimization-status" role="status" aria-live="polite">Label recommendation unavailable. {unavailableReason(recommendation.reason)}</p>
      )}
      {!query.isLoading && !query.error && recommendation?.status === "available" && (
        <div className="job-label-optimization-content" aria-live="polite">
          <dl className="job-label-optimization-evidence">
            <div><dt>Successful runs</dt><dd>{recommendation.successfulRunCount}</dd></div>
            <div><dt>Telemetry coverage</dt><dd>{formatPercent(recommendation.telemetryCoveragePercent)}</dd></div>
            <div><dt>Observed p95 CPU</dt><dd>{formatPercent(recommendation.p95CpuPeakPercent)}</dd></div>
            <div><dt>Observed p95 memory</dt><dd>{formatBytes(recommendation.p95MemoryPeakBytes)}</dd></div>
          </dl>
          <div className="job-label-optimization-fields">
            <label>Windows routing label<input value={recommendation.currentWindowsLabel ?? "Unavailable"} readOnly aria-readonly="true" /></label>
            <label>VCPU label<input name="vcpu" type="number" min="1" step="1" inputMode="numeric" value={vcpu} onChange={(event) => setVcpuValue(event.target.value)} aria-invalid={vcpu.length > 0 && !isPositiveIntegerLabel(vcpu)} /></label>
            <label>Memory label (GiB)<input name="memoryGiB" type="number" min="1" step="1" inputMode="numeric" value={memoryGiB} onChange={(event) => setMemoryValue(event.target.value)} aria-invalid={memoryGiB.length > 0 && !isPositiveIntegerLabel(memoryGiB)} /></label>
          </div>
          <div className="job-label-optimization-diff" aria-label="Runner label changes">
            <div><span>Before</span><code>{current.join(" ") || "Unavailable"}</code></div>
            <span aria-hidden="true">→</span>
            <div><span>After</span><code>{proposed.join(" ") || "Unavailable"}</code></div>
          </div>
          {invalidMessage && <p className="job-label-optimization-validation" role="status">{invalidMessage}</p>}
          {hasRepositoryMetadata && (onRequestPullRequest || onCreatePullRequest) && (
            <button type="button" className="button" disabled={!canRequestPullRequest} onClick={() => {
              if (!canRequestPullRequest || !requestPullRequest || !recommendation || !selectedPath || !selectedJobId) return;
              requestPullRequest({ selectedPath, selectedJobId, labels: proposed, p95CpuPeakPercent: recommendation.p95CpuPeakPercent, p95MemoryPeakBytes: recommendation.p95MemoryPeakBytes, successfulRunCount: recommendation.successfulRunCount });
            }}>Review pull request</button>
          )}
        </div>
      )}
    </section>
  );
}
