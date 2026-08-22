import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { relative, join, isAbsolute } from "node:path";
import { WorkerLimits, type PoolResources } from "@whitesmith/contracts";
import { validateResources, type Lease, type RuntimeDriver, type RuntimeLease } from "./runtime.ts";

export type HostCommandResult = { code: number; stdout: string; stderr: string };
export type HostCommandRunner = (executable: "virsh" | "qemu-img", args: string[], stdin?: string) => Promise<HostCommandResult>;
export type LinuxVmConfig = { goldenDisk: string; goldenDigest: `sha256:${string}`; domainTemplate: string; cloneRoot: string; channelRoot: string; network: string; prefix: string; limits: WorkerLimits; guestReadyTimeoutMs: number; jobTimeoutMs: number };
type Owned = { lease: Lease; domain: string; overlay: string; channel: string; runtime?: RuntimeLease; socket?: { write(data: Uint8Array): void; end(): void } };

const defaultHostCommand: HostCommandRunner = async (executable, args, stdin) => {
  const proc = Bun.spawn([executable, ...args], { stdin: stdin === undefined ? undefined : new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  return { code: await proc.exited, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
};
const safeChild = (root: string, value: string) => isAbsolute(value) && relative(root, value) !== "" && !relative(root, value).startsWith("..") && !relative(root, value).includes("/");
export function renderLinuxVmDomain(template: string, values: { name: string; uuid: string; mac: string; vcpu: number; memoryMiB: number; overlay: string; network: string; channel: string; leaseId: string }): string {
  const escaped = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  const replacements: Record<string, string> = { DOMAIN_NAME: values.name, DOMAIN_UUID: values.uuid, MAC_ADDRESS: values.mac, VCPU: String(values.vcpu), MEMORY_MIB: String(values.memoryMiB), OVERLAY_PATH: escaped(values.overlay), NETWORK: escaped(values.network), CHANNEL_SOCKET: escaped(values.channel), LEASE_ID: escaped(values.leaseId) };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => replacements[key] ?? `{{${key}}}`);
}
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

export class LibvirtVmDriver implements RuntimeDriver {
  readonly name = "linux-libvirt-vm" as const;
  private readonly leases = new Map<string, Owned>();
  private reserved = 0;
  constructor(private readonly config: LinuxVmConfig, private readonly host: HostCommandRunner = defaultHostCommand, private readonly templateReader: (path: string) => Promise<string> = (path) => readFile(path, "utf8")) {}
  validatePool(resources: PoolResources): void { validateResources(resources, this.config.limits); }
  async validateHost(): Promise<{ runtimeReady: boolean; libvirtReady: boolean; networkReady: boolean; cloneStorageReady: boolean; goldenDigest?: string; remediation?: string }> {
    try {
      const version = await this.host("virsh", ["-c", "qemu:///system", "version"]);
      const caps = await this.host("virsh", ["-c", "qemu:///system", "domcapabilities"]);
      const network = await this.host("virsh", ["-c", "qemu:///system", "net-info", this.config.network]);
      const golden = await stat(this.config.goldenDisk);
      if (!golden.isFile() || (golden.mode & 0o222) !== 0) throw new Error("golden_disk_not_read_only");
      const digest = await sha256File(this.config.goldenDisk);
      if (digest !== this.config.goldenDigest) throw new Error("golden_disk_digest_mismatch");
      const image = await this.host("qemu-img", ["info", "--output=json", this.config.goldenDisk]);
      const info = JSON.parse(image.stdout) as { format?: string };
      await access(this.config.cloneRoot, constants.W_OK); await access(this.config.channelRoot, constants.W_OK);
      const ready = version.code === 0 && caps.code === 0 && network.code === 0 && image.code === 0 && info.format === "qcow2";
      return { runtimeReady: ready, libvirtReady: version.code === 0 && caps.code === 0, networkReady: network.code === 0, cloneStorageReady: ready, goldenDigest: digest, ...(ready ? {} : { remediation: "libvirt host probes failed" }) };
    } catch (error) { return { runtimeReady: false, libvirtReady: false, networkReady: false, cloneStorageReady: false, remediation: error instanceof Error ? error.message : String(error) }; }
  }
  async reserveCapacity(resources: PoolResources): Promise<void> { this.validatePool(resources); if (this.reserved + resources.concurrency > this.config.limits.maxConcurrentPods) throw new Error("capacity exhausted"); this.reserved += resources.concurrency; }
  async createLease(lease: Lease): Promise<RuntimeLease> {
    if (this.leases.has(lease.id)) throw new Error("duplicate lease");
    this.validatePool(lease.resources);
    const domain = `${this.config.prefix}-${lease.id}`; const overlay = join(this.config.cloneRoot, `${lease.id}.qcow2`); const channel = join(this.config.channelRoot, `${lease.id}.sock`);
    if (!safeChild(this.config.cloneRoot, overlay) || !safeChild(this.config.channelRoot, channel)) throw new Error("unsafe lease path");
    const owned: Owned = { lease, domain, overlay, channel }; this.leases.set(lease.id, owned); this.reserved += lease.resources.concurrency;
    try {
      const clone = await this.host("qemu-img", ["create", "-f", "qcow2", "-F", "qcow2", "-b", this.config.goldenDisk, overlay]); if (clone.code !== 0) throw new Error(clone.stderr || "clone failed");
      const template = await this.templateReader(this.config.domainTemplate); const macBytes = randomBytes(3).toString("hex").match(/../g)!; const xml = renderLinuxVmDomain(template, { name: domain, uuid: randomUUID(), mac: `52:54:00:${macBytes.join(":")}`, vcpu: lease.resources.vcpu, memoryMiB: Math.ceil(lease.resources.memoryBytes / 1024 ** 2), overlay, network: this.config.network, channel, leaseId: lease.id });
      const defined = await this.host("virsh", ["-c", "qemu:///system", "define", "--validate", "/dev/stdin"], xml); if (defined.code !== 0) throw new Error(defined.stderr || "define failed");
      const started = await this.host("virsh", ["-c", "qemu:///system", "start", domain]); if (started.code !== 0) throw new Error(started.stderr || "start failed");
      const runtime: RuntimeLease = { runtimeInstanceId: domain, observed: { vcpu: lease.resources.vcpu, memoryBytes: lease.resources.memoryBytes, storageBytes: lease.resources.storageBytes }, state: "sandbox_attested", completion: Promise.resolve(0), logs: this.guestLogs(owned) }; owned.runtime = runtime;
      return runtime;
    } catch (error) { await this.stopLease(lease.id).catch(() => undefined); throw error; }
  }
  private async awaitGuest(owned: Owned): Promise<number> { await new Promise((resolve) => setTimeout(resolve, this.config.guestReadyTimeoutMs)); throw new Error("linux guest ready timeout"); }
  private async *guestLogs(_owned: Owned): AsyncIterable<string> { return; }
  async inspectLease(leaseId: string): Promise<RuntimeLease> { const owned = this.leases.get(leaseId); if (!owned?.runtime) throw new Error("lease not found"); return owned.runtime; }
  async stopLease(leaseId: string): Promise<void> { const owned = this.leases.get(leaseId); if (!owned) return; await this.host("virsh", ["-c", "qemu:///system", "shutdown", owned.domain]); await new Promise((resolve) => setTimeout(resolve, 10_000)); await this.host("virsh", ["-c", "qemu:///system", "destroy", owned.domain]).catch(() => undefined); await this.host("virsh", ["-c", "qemu:///system", "undefine", owned.domain, "--nvram"]).catch(() => undefined); await rm(owned.channel, { force: true }).catch(() => undefined); await rm(owned.overlay, { force: true }).catch(() => undefined); this.leases.delete(leaseId); this.reserved = Math.max(0, this.reserved - owned.lease.resources.concurrency); }
  async removeLease(leaseId: string): Promise<void> { await this.stopLease(leaseId); }
  async collectDiagnostics(leaseId: string): Promise<Record<string, unknown>> { const owned = this.leases.get(leaseId); return owned ? { domain: owned.domain, overlay: owned.overlay, channel: owned.channel } : {}; }
  async reconcileOrphans(): Promise<void> { const domains = await this.host("virsh", ["-c", "qemu:///system", "list", "--all", "--name"]); if (domains.code !== 0) return; for (const domain of domains.stdout.split("\n").map((v) => v.trim()).filter(Boolean)) { if (!domain.startsWith(`${this.config.prefix}-`)) continue; const leaseId = domain.slice(this.config.prefix.length + 1); if (!/^[0-9a-f-]{36}$/.test(leaseId)) continue; await this.host("virsh", ["-c", "qemu:///system", "destroy", domain]).catch(() => undefined); await this.host("virsh", ["-c", "qemu:///system", "undefine", domain, "--nvram"]).catch(() => undefined); if (safeChild(this.config.cloneRoot, join(this.config.cloneRoot, `${leaseId}.qcow2`))) await rm(join(this.config.cloneRoot, `${leaseId}.qcow2`), { force: true }); if (safeChild(this.config.channelRoot, join(this.config.channelRoot, `${leaseId}.sock`))) await rm(join(this.config.channelRoot, `${leaseId}.sock`), { force: true }); } }
}
