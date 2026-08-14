import { randomUUID } from "node:crypto";
import type { PoolResources, WorkerLimits } from "@whitesmith/contracts";
import type { Lease, RuntimeDriver, RuntimeLease } from "./runtime.ts";
import { validateResources } from "./runtime.ts";

export type KubectlResult = { code: number; stdout: string; stderr: string };
export type KubectlRunner = (args: string[], stdin?: string) => Promise<KubectlResult>;
export type KataK3sConfig = { namespace: string; runtimeClassName: "whitesmith-kata"; image: string; prefix: string; limits: WorkerLimits; jobTimeoutMs: number };

type Owned = { pod: string; secret: string; runtime: RuntimeLease };
const digest = /^[^@\s]+@sha256:[0-9a-f]{64}$/;

async function defaultKubectl(args: string[], stdin?: string): Promise<KubectlResult> {
  const process = Bun.spawn(["kubectl", ...args], { stdin: stdin === undefined ? undefined : new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  return { code: await process.exited, stdout: await new Response(process.stdout).text(), stderr: await new Response(process.stderr).text() };
}

export class KataK3sDriver implements RuntimeDriver {
  readonly name = "kata-k3s" as const;
  private readonly leases = new Map<string, Owned>();
  constructor(private readonly config: KataK3sConfig | WorkerLimits, private readonly kubectl: KubectlRunner = defaultKubectl) {}
  private get settings(): KataK3sConfig { return "namespace" in this.config ? this.config : { namespace: "default", runtimeClassName: "whitesmith-kata", image: "", prefix: "whitesmith", limits: this.config, jobTimeoutMs: 15 * 60_000 }; }
  validatePool(resources: PoolResources): void { validateResources(resources, this.settings.limits); if (!digest.test(this.settings.image) && this.settings.image) throw new Error("Kata image must be digest pinned"); }
  async reserveCapacity(resources: PoolResources): Promise<void> {
    this.validatePool(resources);
    const result = await this.kubectl(["get", "runtimeclass", this.settings.runtimeClassName, "-o", "json"]);
    if (result.code !== 0) throw new Error("Kata RuntimeClass unavailable");
    const runtimeClass = JSON.parse(result.stdout) as { handler?: string };
    if (runtimeClass.handler !== "kata") throw new Error("Kata RuntimeClass handler mismatch");
  }
  async createLease(lease: Lease): Promise<RuntimeLease> {
    this.validatePool(lease.resources);
    const pod = `${this.settings.prefix}-${lease.id}`;
    const secret = `${pod}-bootstrap`;
    const manifest = { apiVersion: "v1", kind: "Pod", metadata: { name: pod, namespace: this.settings.namespace, labels: { "whitesmith.managed": "true", "whitesmith.lease-id": lease.id } }, spec: { runtimeClassName: this.settings.runtimeClassName, automountServiceAccountToken: false, restartPolicy: "Never", securityContext: { seccompProfile: { type: "RuntimeDefault" } }, containers: [{ name: "job", image: this.settings.image || lease.imageDigest, command: ["/usr/local/bin/whitesmith-job-agent", "guest-service", "--platform", "linux-x64", "--completion-mode", "exit", "--bootstrap-file", "/var/lib/whitesmith/bootstrap/bootstrap.json", "--runner-root", "/opt/actions-runner"], resources: { requests: { cpu: String(lease.resources.vcpu), memory: String(lease.resources.memoryBytes) }, limits: { cpu: String(lease.resources.vcpu), memory: String(lease.resources.memoryBytes) } }, securityContext: { allowPrivilegeEscalation: false, privileged: false, capabilities: { drop: ["ALL"] } }, volumeMounts: [{ name: "bootstrap", mountPath: "/var/lib/whitesmith/bootstrap", readOnly: true }, { name: "work", mountPath: "/work" }] }], volumes: [{ name: "bootstrap", secret: { secretName: secret } }, { name: "work", emptyDir: { sizeLimit: `${lease.resources.storageBytes}` } }] } };
    const secretManifest = { apiVersion: "v1", kind: "Secret", metadata: { name: secret, namespace: this.settings.namespace, labels: { "whitesmith.managed": "true", "whitesmith.lease-id": lease.id } }, stringData: { "bootstrap.json": JSON.stringify({ version: 1, leaseId: lease.id, nonce: lease.nonce, encodedJitConfig: lease.encodedJitConfig }) } };
    const appliedSecret = await this.kubectl(["apply", "-f", "-"], JSON.stringify(secretManifest));
    if (appliedSecret.code !== 0) throw new Error("Kata bootstrap Secret creation failed");
    const appliedPod = await this.kubectl(["apply", "-f", "-"], JSON.stringify(manifest));
    if (appliedPod.code !== 0) { await this.removeObjects(pod, secret); throw new Error("Kata Pod creation failed"); }
    const observed = { vcpu: lease.resources.vcpu, memoryBytes: lease.resources.memoryBytes, storageBytes: lease.resources.storageBytes };
    const runtime: RuntimeLease = { runtimeInstanceId: pod, observed, state: "sandbox_attested", completion: this.waitForCompletion(pod) };
    this.leases.set(lease.id, { pod, secret, runtime });
    return runtime;
  }
  private async waitForCompletion(pod: string): Promise<number> { const deadline = Date.now() + this.settings.jobTimeoutMs; while (Date.now() < deadline) { const result = await this.kubectl(["get", "pod", pod, "-n", this.settings.namespace, "-o", "json"]); if (result.code === 0) { const value = JSON.parse(result.stdout) as { status?: { phase?: string; containerStatuses?: Array<{ state?: { terminated?: { exitCode?: number } } }> } }; const terminated = value.status?.containerStatuses?.[0]?.state?.terminated; if (terminated) return terminated.exitCode ?? 1; } await Bun.sleep(250); } throw new Error("Kata lease timed out"); }
  private async removeObjects(pod: string, secret: string): Promise<void> { await this.kubectl(["delete", "pod", pod, "-n", this.settings.namespace, "--ignore-not-found=true"]); await this.kubectl(["delete", "secret", secret, "-n", this.settings.namespace, "--ignore-not-found=true"]); }
  async inspectLease(leaseId: string): Promise<RuntimeLease> { const owned = this.leases.get(leaseId); if (!owned) throw new Error("sandbox not found"); return owned.runtime; }
  async stopLease(leaseId: string): Promise<void> { const owned = this.leases.get(leaseId); if (owned) await this.kubectl(["delete", "pod", owned.pod, "-n", this.settings.namespace, "--ignore-not-found=true"]); }
  async removeLease(leaseId: string): Promise<void> { const owned = this.leases.get(leaseId); if (!owned) return; try { await this.removeObjects(owned.pod, owned.secret); } finally { this.leases.delete(leaseId); } }
  async collectDiagnostics(leaseId: string): Promise<Record<string, unknown>> { const runtime = await this.inspectLease(leaseId); return { runtimeClass: this.settings.runtimeClassName, handler: "kata", runtimeInstanceId: runtime.runtimeInstanceId, observed: runtime.observed }; }
}
