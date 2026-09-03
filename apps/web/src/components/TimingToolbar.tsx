import type { JobResourceTrendResponse, JobResourceTrendSort } from "@mars/contracts";
import { defaultTimingFilters, formatDate, type TimingFilters, type TimingRange } from "../routes/timing-model.ts";

export type TimingToolbarProps = {
  filters: TimingFilters;
  facets: JobResourceTrendResponse["filters"];
  generatedAt: string | null;
  refreshing: boolean;
  onChange(next: TimingFilters): void;
  onRefresh(): void;
};

const ranges: readonly TimingRange[] = ["24h", "7d", "30d", "90d"];
const sorts: readonly { value: JobResourceTrendSort; label: string }[] = [
  { value: "latest", label: "Latest completion" },
  { value: "duration", label: "Median duration" },
  { value: "cpu", label: "CPU peak" },
  { value: "memory", label: "Memory peak" },
  { value: "runs", label: "Run count" },
];

export function TimingToolbar({ filters, facets, generatedAt, refreshing, onChange, onRefresh }: TimingToolbarProps) {
  const isDefault = filters.range === defaultTimingFilters.range
    && filters.platform === defaultTimingFilters.platform
    && filters.vcpu === defaultTimingFilters.vcpu
    && filters.concurrency === defaultTimingFilters.concurrency
    && filters.search === defaultTimingFilters.search
    && filters.sort === defaultTimingFilters.sort;

  return (
    <section className="resource-history-toolbar filter-bar" aria-label="Timing history filters">
      <fieldset className="resource-history-ranges">
        <legend>Time range</legend>
        <div role="group" aria-label="Time range">
          {ranges.map((range) => (
            <button
              key={range}
              type="button"
              aria-pressed={filters.range === range}
              onClick={() => onChange({ ...filters, range })}
            >
              {range}
            </button>
          ))}
        </div>
      </fieldset>

      <label>
        Platform
        <select value={filters.platform} onChange={(event) => onChange({ ...filters, platform: event.target.value })}>
          <option value="">All platforms</option>
          {facets.platforms.map((platform) => <option key={platform} value={platform}>{platform}</option>)}
        </select>
      </label>

      <label>
        vCPU
        <select value={filters.vcpu} onChange={(event) => onChange({ ...filters, vcpu: event.target.value })}>
          <option value="">All vCPU sizes</option>
          {facets.vcpus.map((vcpu) => <option key={vcpu} value={vcpu}>{vcpu}</option>)}
        </select>
      </label>

      <label>
        Concurrency
        <select value={filters.concurrency} onChange={(event) => onChange({ ...filters, concurrency: event.target.value })}>
          <option value="">All concurrency levels</option>
          {facets.concurrencies.map((concurrency) => <option key={concurrency} value={concurrency}>{concurrency}</option>)}
        </select>
      </label>

      <label>
        Search jobs
        <input
          type="search"
          value={filters.search}
          placeholder="Repository, workflow, or job"
          onChange={(event) => onChange({ ...filters, search: event.target.value })}
        />
      </label>

      <label>
        Sort by
        <select value={filters.sort} onChange={(event) => onChange({ ...filters, sort: event.target.value as JobResourceTrendSort })}>
          {sorts.map((sort) => <option key={sort.value} value={sort.value}>{sort.label}</option>)}
        </select>
      </label>

      <div className="resource-history-toolbar-actions">
        {!isDefault && <button type="button" className="button secondary" onClick={() => onChange(defaultTimingFilters)}>Reset</button>}
        <button type="button" className="button" disabled={refreshing} onClick={onRefresh}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <p className="resource-history-update-status" role="status" aria-live="polite">
        {refreshing
          ? "Refreshing job resource history…"
          : generatedAt
            ? <>Updated <time dateTime={generatedAt}>{formatDate(generatedAt)}</time></>
            : "Not refreshed yet"}
      </p>
    </section>
  );
}
