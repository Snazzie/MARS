import { z } from "zod";

export const ANY_RUNNER_LABEL = "mars-any";
export const ANY_X64_RUNNER_LABEL = "mars-any-x64";

const RESERVED_TRIGGER_LABELS = ["self-hosted", "linux", "windows", "macos", "x64", "arm64", ANY_RUNNER_LABEL, ANY_X64_RUNNER_LABEL];

/** Resource-free label used to identify a runner pool. */
export const RunnerTriggerLabel = z.string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,62}$/)
  .refine((label) => !RESERVED_TRIGGER_LABELS.includes(label));
export type RunnerTriggerLabel = z.infer<typeof RunnerTriggerLabel>;

export type ParsedRunnerLabel = {
  /** The original composite label, with any caller-provided casing preserved. */
  original: string;
  /** The route portion, normalized to lowercase. */
  route: string;
  vcpu: number;
  memoryGiB: number;
  memoryBytes: number;
};

const MEMORY_BYTES_PER_GIB = 1024 ** 3;
const MAX_MEMORY_GIB = Math.floor(Number.MAX_SAFE_INTEGER / MEMORY_BYTES_PER_GIB);
const compositeLabel = /^(.+)-([1-9][0-9]*)vcpu-([1-9][0-9]*)g$/i;

function validResource(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validRoute(route: string): boolean {
  return route === ANY_RUNNER_LABEL
    || route === ANY_X64_RUNNER_LABEL
    || RunnerTriggerLabel.safeParse(route).success;
}

/** Parse one case-insensitive composite runner label. */
export function parseRunnerLabel(label: string): ParsedRunnerLabel | null {
  if (typeof label !== "string") return null;
  const match = compositeLabel.exec(label);
  if (!match) return null;

  const route = match[1].toLowerCase();
  if (!validRoute(route)) return null;

  const vcpu = Number(match[2]);
  const memoryGiB = Number(match[3]);
  if (!validResource(vcpu) || !validResource(memoryGiB) || memoryGiB > MAX_MEMORY_GIB) return null;

  return { original: label, route, vcpu, memoryGiB, memoryBytes: memoryGiB * MEMORY_BYTES_PER_GIB };
}

/**
 * Parse a complete set of OR alternatives, rejecting ambiguous or malformed
 * requests. Input labels are trimmed before parsing and are returned in their
 * trimmed form as their `original` field.
 */
export function parseRunnerLabels(labels: readonly string[]): ParsedRunnerLabel[] | null {
  if (!Array.isArray(labels) || labels.length === 0) return null;

  const parsed: ParsedRunnerLabel[] = [];
  const fullLabels = new Set<string>();
  const routes = new Map<string, { vcpu: number; memoryGiB: number }>();
  for (const input of labels) {
    if (typeof input !== "string") return null;
    const label = input.trim();
    if (!label) return null;
    const option = parseRunnerLabel(label);
    if (!option) return null;

    const normalizedLabel = label.toLowerCase();
    if (fullLabels.has(normalizedLabel)) return null;
    fullLabels.add(normalizedLabel);

    const prior = routes.get(option.route);
    if (prior && (prior.vcpu !== option.vcpu || prior.memoryGiB !== option.memoryGiB)) return null;
    routes.set(option.route, { vcpu: option.vcpu, memoryGiB: option.memoryGiB });
    parsed.push(option);
  }
  return parsed;
}

/** Format a canonical lowercase composite runner label. */
export function formatRunnerLabel(route: string, vcpu: number, memoryGiB: number): string {
  if (typeof route !== "string") throw new RangeError("Invalid runner route");
  const normalizedRoute = route.toLowerCase();
  if (!validRoute(normalizedRoute)) throw new RangeError("Invalid runner route");
  if (!validResource(vcpu) || !validResource(memoryGiB) || memoryGiB > MAX_MEMORY_GIB) {
    throw new RangeError("Runner resources must be positive safe integers");
  }
  return `${normalizedRoute}-${vcpu}vcpu-${memoryGiB}g`;
}
