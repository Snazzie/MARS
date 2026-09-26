import { readFile } from "node:fs/promises";

export function parseAllowedCpuIds(status: string): number[] | undefined {
  const value = /^Cpus_allowed_list:\s*([^\r\n]+)$/m.exec(status)?.[1]?.trim();
  if (!value) return undefined;
  const ids = new Set<number>();
  for (const segment of value.split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(segment.trim());
    if (!match) return undefined;
    const start = Number(match[1]), end = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end > 65535 || end < start || end - start > 65535) return undefined;
    for (let id = start; id <= end; id++) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}
export async function allowedCpuIds(): Promise<number[] | undefined> {
  try { return parseAllowedCpuIds(await readFile("/proc/self/status", "utf8")); } catch { return undefined; }
}
export async function validateExclusiveCpuIds(cpuIds: number[] | undefined, vcpu: number): Promise<string> {
  if (!cpuIds || cpuIds.length !== vcpu || cpuIds.some((id, index) => !Number.isInteger(id) || id < 0 || id > 65535 || index > 0 && id <= cpuIds[index - 1]!)) throw new Error("invalid exclusive CPU claim");
  const allowed = await allowedCpuIds();
  if (!allowed?.length || cpuIds.some(id => !allowed.includes(id))) throw new Error("exclusive CPU claim is no longer allowed on host");
  return cpuIds.join(",");
}
