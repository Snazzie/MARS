import type { JobResourceTrendJob, JobResourceTrendSort } from "@mars/contracts";

export type TimingRange = "24h" | "7d" | "30d" | "90d";

export type TimingFilters = {
  range: TimingRange;
  platform: string;
  vcpu: string;
  concurrency: string;
  search: string;
  sort: JobResourceTrendSort;
};

export const defaultTimingFilters: TimingFilters = {
  range: "7d",
  platform: "",
  vcpu: "",
  concurrency: "",
  search: "",
  sort: "latest",
};

const rangeDurationMs: Record<TimingRange, number> = {
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "30d": 30 * 24 * 60 * 60 * 1_000,
  "90d": 90 * 24 * 60 * 60 * 1_000,
};

const byteFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const iecFormatter = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const percentFormatters = new Map<number, Intl.NumberFormat>();
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "UTC",
  timeZoneName: "short",
});

function decimalFormatter(digits: number): Intl.NumberFormat {
  const normalizedDigits = Math.max(0, Math.min(20, Math.trunc(digits)));
  const existing = percentFormatters.get(normalizedDigits);
  if (existing) return existing;
  const formatter = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: normalizedDigits,
    maximumFractionDigits: normalizedDigits,
  });
  percentFormatters.set(normalizedDigits, formatter);
  return formatter;
}

export function timingRangeBounds(range: TimingRange, now: Date = new Date()): { from: string; to: string } {
  const to = now.getTime();
  return {
    from: new Date(to - rangeDurationMs[range]).toISOString(),
    to: new Date(to).toISOString(),
  };
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 60 * 60) return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
  return `${Math.floor(totalSeconds / (60 * 60))}h ${Math.floor((totalSeconds % (60 * 60)) / 60)}m`;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "Unavailable";
  if (bytes < 1_024) return `${byteFormatter.format(bytes)} B`;
  if (bytes < 1_024 ** 2) return `${iecFormatter.format(bytes / 1_024)} KiB`;
  if (bytes < 1_024 ** 3) return `${iecFormatter.format(bytes / 1_024 ** 2)} MiB`;
  if (bytes < 1_024 ** 4) return `${iecFormatter.format(bytes / 1_024 ** 3)} GiB`;
  return `${iecFormatter.format(bytes / 1_024 ** 4)} TiB`;
}

export function formatPercent(value: number | null, digits = 1): string {
  return value === null ? "Unavailable" : `${decimalFormatter(digits).format(value)}%`;
}

export function formatDeltaPercent(value: number | null, digits = 1): string {
  if (value === null) return "Unavailable";
  if (value === 0) return formatPercent(0, digits);
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${formatPercent(value, digits)}`;
}

export function formatDate(iso: string): string {
  return dateFormatter.format(new Date(iso));
}

export function selectionAfterJobsChange(current: string | null, jobs: readonly JobResourceTrendJob[]): string | null {
  if (current !== null && jobs.some((job) => job.jobKey === current)) return current;
  return jobs[0]?.jobKey ?? null;
}
