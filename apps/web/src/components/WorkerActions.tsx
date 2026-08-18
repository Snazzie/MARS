import { useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { ApiRequestError, mutateWorker } from "../api.ts";

type Action = "reject" | "drain" | "resume" | "remove";
const copy: Record<Action, { label: string; confirm: string; variant: "primary" | "secondary" | "destructive" }> = {
 reject: { label: "Reject", confirm: "Reject this worker? Its enrollment will be revoked and it will not receive work.", variant: "destructive" },
 drain: { label: "Drain", confirm: "Drain this worker? New leases will stop while active work completes.", variant: "secondary" },
 resume: { label: "Resume", confirm: "Resume this worker? It will become eligible for new leases after its configuration and runtime checks are ready.", variant: "primary" },
 remove: { label: "Remove", confirm: "Remove this worker? Pools will be disabled and the worker will be revoked after active leases finish.", variant: "destructive" },
};
export function buildWindowsUpgradeCommand(workerId: string, origin: string, runtime: "container" | "vm" = "container"): string {
 const base = new URL(origin);
 if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error("Upgrade origin must use HTTP or HTTPS");
 const protocol = base.protocol.slice(0, -1);
 const tls = protocol === "https" ? " --tlsv1.3" : "";
 const insecure = protocol === "http" ? " -AllowInsecureHttp" : "";
 const url = `${origin.replace(/\/$/, "")}/api/workers/installer?audience=windows-x64&runtime=${runtime}`;
 return `# Whitesmith worker ${workerId}\n$script = Join-Path $env:TEMP ("whitesmith-upgrade-" + [guid]::NewGuid() + ".ps1")\ntry {\n  curl.exe --fail --proto '=${protocol}'${tls}${insecure} --output $script '${url}'\n  if ($LASTEXITCODE -ne 0) { throw "Upgrade command download failed with exit code $LASTEXITCODE" }\n  powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -Upgrade -WindowsRuntime '${runtime}'\n} finally {\n  Remove-Item -LiteralPath $script -Force -ErrorAction SilentlyContinue\n}`;
}
export function WorkerActions({ organizationId, workerId, admissionState, draining, activeSandboxes = 0, platform, runtimeMode, onComplete }: { organizationId: string; workerId: string; admissionState: string; draining: boolean; activeSandboxes?: number; platform?: string; runtimeMode?: "container" | "vm" | null; onComplete: () => void }) {
 const [action, setAction] = useState<Action | null>(null);
 const [upgradeCommand, setUpgradeCommand] = useState<string | null>(null);
 const [error, setError] = useState<string | null>(null);
 const [pending, setPending] = useState(false);
 const dialog = useRef<HTMLDialogElement>(null);
 function open(next: Action) { setError(null); setAction(next); dialog.current?.showModal(); }
 function openUpgrade() { setError(null); setUpgradeCommand(buildWindowsUpgradeCommand(workerId, window.location.origin, runtimeMode ?? "container")); }
 function close() { dialog.current?.close(); setAction(null); setUpgradeCommand(null); }
 async function confirm() {
  if (!action) return;
  setPending(true); setError(null);
  try { await mutateWorker(organizationId, workerId, action); close(); onComplete(); }
  catch (reason) { setError(reason instanceof ApiRequestError ? reason.message : "The action could not be completed."); }
  finally { setPending(false); }
 }
 return <>
  <div className="worker-actions" aria-label="Worker actions">
   {admissionState === "pending" && <Button label="Reject" variant="destructive" clickAction={() => open("reject")} />}
   {admissionState === "adopted" && <><Button label={draining ? "Resume" : "Drain"} variant="secondary" clickAction={() => open(draining ? "resume" : "drain")} />{platform === "windows-x64" && <Button label="Upgrade" variant="secondary" clickAction={openUpgrade} />}{<Button label="Remove" variant="destructive" clickAction={() => open("remove")} />}</>}
  </div>
  {upgradeCommand && <dialog open className="confirm-dialog" aria-labelledby="worker-upgrade-title"><form method="dialog"><p className="panel-kicker">Manual upgrade</p><h2 id="worker-upgrade-title">Copy upgrade command</h2><p>Drain this worker and wait for zero active jobs before running this command in an Administrator PowerShell.</p><textarea aria-label="Windows worker upgrade command" readOnly value={upgradeCommand} /><div className="dialog-actions"><Button label="Close" variant="secondary" onClick={() => setUpgradeCommand(null)} /><Button label="Copy command" variant="primary" clickAction={() => void navigator.clipboard?.writeText(upgradeCommand)} /></div></form></dialog>}
  <dialog ref={dialog} className="confirm-dialog" onCancel={close} aria-labelledby="worker-confirm-title">
   <form method="dialog" onSubmit={(event) => { event.preventDefault(); void confirm(); }}><p className="panel-kicker">Confirm action</p><h2 id="worker-confirm-title">{action ? copy[action].label : "Worker action"}</h2><p>{action ? copy[action].confirm : ""}</p>{error && <p className="inline-error" role="alert">{error}</p>}<div className="dialog-actions"><Button label="Cancel" variant="secondary" onClick={close} isDisabled={pending} /><Button label={action ? copy[action].label : "Confirm"} variant={action ? copy[action].variant : "primary"} type="submit" isLoading={pending} /></div></form>
  </dialog>
 </>;
}
