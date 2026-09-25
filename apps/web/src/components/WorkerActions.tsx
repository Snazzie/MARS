import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@astryxdesign/core/Button";
import { ApiRequestError, getWorkerControlPlaneUrls, getWorkerUpgrade, mutateWorker } from "../api.ts";

type Action = "reject" | "drain" | "resume" | "remove";
const copy: Record<Action, { label: string; confirm: string; variant: "primary" | "secondary" | "destructive" }> = {
 reject: { label: "Reject", confirm: "Reject this worker? Its enrollment will be revoked and it will not receive work.", variant: "destructive" },
 drain: { label: "Pause new leases", confirm: "Pause new lease assignment for this worker? Existing leases will finish normally.", variant: "secondary" },
 resume: { label: "Resume new leases", confirm: "Resume new lease assignment for this worker? It will become eligible after configuration and runtime checks are ready.", variant: "primary" },
 remove: { label: "Remove", confirm: "Remove this worker? Pools will be disabled and the worker will be revoked after active leases finish.", variant: "destructive" },
};
function quotePowerShell(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
function installerUrl(origin: string, platform: string, token: string): string {
 return `${origin}/api/workers/installer?audience=${platform}&upgrade=true&connectOrigin=${encodeURIComponent(origin)}&target=${encodeURIComponent(token)}`;
}
export function buildWindowsUpgradeCommand(workerId: string, origin: string, connectOrigin: string = origin, token = ""): string {
 const selectedOrigin = new URL(connectOrigin || origin).origin;
 if (!/^https?:$/.test(new URL(selectedOrigin).protocol)) throw new Error("Upgrade origin must use HTTP or HTTPS");
 const controlPlane = quotePowerShell(selectedOrigin);
 const installer = installerUrl(selectedOrigin, "windows-x64", token);
 const installerProtocol = installer.startsWith("http:") ? "http" : "https";
 const tls = installerProtocol === "https" ? " --tlsv1.3" : "";
 return `# Mars worker ${workerId}\n$script = Join-Path $env:TEMP ("mars-upgrade-" + [guid]::NewGuid() + ".ps1")\ntry {\n  curl.exe --fail --proto '=${installerProtocol}'${tls} --output $script '${installer}'\n  if ($LASTEXITCODE -ne 0) { throw "Upgrade command download failed with exit code $LASTEXITCODE" }\n  powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -ControlPlaneUrl ${controlPlane} -Upgrade${selectedOrigin.startsWith("http:") ? " -AllowInsecureHttp" : ""}\n} finally {\n  Remove-Item -LiteralPath $script -Force -ErrorAction SilentlyContinue\n}`;
}
export function buildUpgradeCommand(workerId: string, origin: string, connectOrigin: string, platform: string, token: string): string {
 const selectedOrigin = new URL(connectOrigin || origin).origin;
 const installer = installerUrl(selectedOrigin, platform, token);
 const protocol = installer.startsWith("http:") ? "http" : "https";
 const tls = protocol === "https" ? " --tlsv1.3" : "";
 const temporary = `mars-upgrade-${workerId}`;
 if (platform === "linux-arm64") return `# Mars worker ${workerId}\n$script = Join-Path $env:TEMP '${temporary}.ps1'\ntry { curl.exe --fail --proto '=${protocol}'${tls} --output $script '${installer}'; if ($LASTEXITCODE -ne 0) { throw 'Upgrade command download failed' }; powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -Upgrade -ControlPlaneUrl ${quotePowerShell(selectedOrigin)} } finally { Remove-Item -LiteralPath $script -Force -ErrorAction SilentlyContinue }`;
 const shell = platform === "macos-arm64" ? "zsh" : "sudo bash";
 return `# Mars worker ${workerId}\ntmp=$(mktemp)\ntrap 'rm -f "$tmp"' EXIT\ncurl --fail --proto '=https'${tls} --output "$tmp" '${installer}'\n${shell} "$tmp" --upgrade --control-plane-url '${selectedOrigin}'`;
}
export function WorkerActions({ organizationId, workerId, admissionState, draining, activeSandboxes = 0, platform, currentReleaseVersion, currentContractVersion, onComplete }: { organizationId: string; workerId: string; admissionState: string; draining: boolean; activeSandboxes?: number; platform?: string; currentReleaseVersion?: string | null; currentContractVersion?: string | null; onComplete: () => void }) {
 const [action, setAction] = useState<Action | null>(null);
 const [upgradeCommand, setUpgradeCommand] = useState<string | null>(null);
 const [upgradeTarget, setUpgradeTarget] = useState<{ releaseVersion: string; contractVersion: string } | null>(null);
 const [error, setError] = useState<string | null>(null);
 const [upgradeError, setUpgradeError] = useState<string | null>(null);
 const [pending, setPending] = useState(false);
 const dialog = useRef<HTMLDialogElement>(null);
 const upgradeQuery = useQuery({ queryKey: ["worker-upgrade", workerId], queryFn: () => getWorkerUpgrade(workerId), enabled: admissionState === "adopted" && Boolean(platform), retry: false });
 function open(next: Action) { setError(null); setUpgradeError(null); setAction(next); dialog.current?.showModal(); }
 async function openUpgrade() {
  setError(null); setUpgradeError(null);
  try {
   const status = (await upgradeQuery.refetch()).data;
   if (!status || !status.available) return;
   const connectOrigin = (await getWorkerControlPlaneUrls())[0];
   setUpgradeTarget({ releaseVersion: status.target.releaseVersion, contractVersion: status.target.contractVersion });
   setUpgradeCommand(platform === "windows-x64" ? buildWindowsUpgradeCommand(workerId, window.location.origin, connectOrigin, status.target.token) : buildUpgradeCommand(workerId, window.location.origin, connectOrigin, platform!, status.target.token));
  } catch (reason) { setUpgradeError(reason instanceof ApiRequestError ? reason.message : reason instanceof Error ? reason.message : "The upgrade command could not be prepared."); }
 }
 function close() { dialog.current?.close(); setAction(null); setUpgradeCommand(null); setUpgradeTarget(null); setError(null); setUpgradeError(null); }
 async function confirm() { if (!action) return; setPending(true); setError(null); try { await mutateWorker(organizationId, workerId, action); close(); onComplete(); } catch (reason) { setError(reason instanceof ApiRequestError ? reason.message : "The action could not be completed."); } finally { setPending(false); } }
 const availableUpgrade = upgradeQuery.data?.available === true ? upgradeQuery.data : null;
 const targetInfo = availableUpgrade?.available === true ? availableUpgrade.target : null;
 const supportsUpgrade = platform === "windows-x64";
 return <>
  <div className="worker-actions" aria-label="Worker actions">
   {admissionState === "adopted" && <><Button label={draining ? "Resume new leases" : "Pause new leases"} variant="secondary" clickAction={() => open(draining ? "resume" : "drain")} />{supportsUpgrade && <Button label={targetInfo ? `Upgrade to v${targetInfo.releaseVersion}` : "Upgrade"} variant="secondary" isDisabled={!targetInfo} clickAction={() => void openUpgrade()} />}{<Button label="Remove" variant="destructive" clickAction={() => open("remove")} />}</>}
  </div>
  {upgradeError && <p className="inline-error" role="alert">{upgradeError}</p>}
  {upgradeCommand && <dialog open className="confirm-dialog" aria-labelledby="worker-upgrade-title"><form method="dialog"><p className="panel-kicker">Manual upgrade</p><h2 id="worker-upgrade-title">Upgrade to v{upgradeTarget?.releaseVersion}</h2><p>Current release: {currentReleaseVersion ?? "Unknown"}; current contract: {currentContractVersion ?? "Unknown"}. Target contract: {upgradeTarget?.contractVersion}. Drain this worker and wait for zero active jobs before running this command.</p><textarea aria-label="Worker upgrade command" readOnly value={upgradeCommand} /><div className="dialog-actions"><Button label="Close" variant="secondary" onClick={() => { setUpgradeCommand(null); setUpgradeError(null); }} /><Button label="Copy command" variant="primary" clickAction={() => void navigator.clipboard?.writeText(upgradeCommand)} /></div></form></dialog>}
  <dialog ref={dialog} className="confirm-dialog" onCancel={close} aria-labelledby="worker-confirm-title"><form method="dialog" onSubmit={(event) => { event.preventDefault(); void confirm(); }}><p className="panel-kicker">Confirm action</p><h2 id="worker-confirm-title">{action ? copy[action].label : "Worker action"}</h2><p>{action ? copy[action].confirm : ""}</p>{error && <p className="inline-error" role="alert">{error}</p>}<div className="dialog-actions"><Button label="Cancel" variant="secondary" onClick={close} isDisabled={pending} /><Button label={action ? copy[action].label : "Confirm"} variant={action ? copy[action].variant : "primary"} type="submit" isLoading={pending} /></div></form></dialog>
 </>;
}
