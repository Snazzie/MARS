import { WorkerContractVersion, WorkerReleaseVersion, WorkerUpgradeStatus, type RuntimePlatform } from "@mars/contracts";
import { z } from "zod";
import type { SecretBox } from "./auth.ts";
import { WorkerReleaseCatalog, type WorkerReleaseTarget } from "./worker-release.ts";

const tokenPayload = z.object({
  workerId: z.string().uuid(),
  platform: z.enum(["linux-x64", "linux-arm64", "windows-x64", "macos-arm64"]),
  currentReleaseVersion: WorkerReleaseVersion,
  targetReleaseVersion: WorkerReleaseVersion,
  targetManifestUrl: z.string().url(),
  expiresAt: z.number().int().positive(),
}).strict();
export type WorkerUpgradeToken = z.infer<typeof tokenPayload>;

export class WorkerUpgradeService {
  constructor(private readonly catalog: WorkerReleaseCatalog, private readonly secretBox: SecretBox, private readonly now: () => number = Date.now) {}
  async suggest(worker: { id: string; platform: RuntimePlatform; releaseVersion?: string | null; contractVersion?: string | null }): Promise<WorkerUpgradeStatus> {
    if (!worker.releaseVersion || !worker.contractVersion) return { available: false, currentReleaseVersion: worker.releaseVersion ?? null, currentContractVersion: worker.contractVersion ?? null };
    const currentReleaseVersion = WorkerReleaseVersion.safeParse(worker.releaseVersion);
    const currentContractVersion = WorkerContractVersion.safeParse(worker.contractVersion);
    if (!currentReleaseVersion.success || !currentContractVersion.success) return { available: false, currentReleaseVersion: null, currentContractVersion: null };
    const target = await this.catalog.findNextCompatible(worker.releaseVersion, worker.platform);
    if (!target) return { available: false, currentReleaseVersion: worker.releaseVersion, currentContractVersion: worker.contractVersion };
    const token = this.issue({ workerId: worker.id, platform: worker.platform, currentReleaseVersion: worker.releaseVersion, targetReleaseVersion: target.releaseVersion, targetManifestUrl: target.manifestUrl, expiresAt: this.now() + 24 * 60 * 60_000 });
    return { available: true, currentReleaseVersion: worker.releaseVersion, currentContractVersion: worker.contractVersion, target: { releaseVersion: target.releaseVersion, contractVersion: target.manifest.contractVersion, token } };
  }
  issue(payload: WorkerUpgradeToken): string { return this.secretBox.encrypt(JSON.stringify(tokenPayload.parse(payload))); }
  read(token: string): WorkerUpgradeToken {
    const value = tokenPayload.parse(JSON.parse(this.secretBox.decrypt(token)));
    if (value.expiresAt <= this.now()) throw new Error("upgrade_target_stale");
    return value;
  }
  async verify(token: string, worker: { id: string; platform: RuntimePlatform; releaseVersion: string | null }, selected: WorkerReleaseTarget): Promise<void> {
    const value = this.read(token);
    if (value.workerId !== worker.id || value.platform !== worker.platform || value.currentReleaseVersion !== worker.releaseVersion || value.targetReleaseVersion !== selected.releaseVersion || value.targetManifestUrl !== selected.manifestUrl) throw new Error("upgrade_target_stale");
  }
}
