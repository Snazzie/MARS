import { useCallback, useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { ApiRequestError, getWorkerBootstrapStatus, getWorkerControlPlaneUrls, initializeWorkerBootstrap, rotateWorkerBootstrap } from "../api.ts";

type RuntimePlatform = "linux-x64" | "linux-arm64" | "windows-x64" | "macos-arm64";
type Reveal = { code: string; generation: number; createdAt: string };
type WorkerConnection = { id: string; connectionState?: string };
export type WorkerConnectionSnapshot = Record<string, string | undefined>;
export function connectionSnapshot(workers: readonly WorkerConnection[]): WorkerConnectionSnapshot {
  return Object.fromEntries(workers.map((worker) => [worker.id, worker.connectionState]));
}
export function connectedEnrollmentWorker(snapshot: WorkerConnectionSnapshot, workers: readonly WorkerConnection[]): string | null {
  return workers.find((worker) => worker.connectionState === "online" && snapshot[worker.id] !== "online")?.id ?? null;
}

function quoteShell(value: string): string { return `'${value.replaceAll("'", "'\"'\"'")}'`; }
function quotePowerShell(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
export type WindowsVmImageSource = "checkpoint" | "iso" | "vhdx";
export type WindowsVmImageOptions = {
  source: WindowsVmImageSource;
  sourcePath?: string;
  sourceSha256?: string;
  imageName?: string;
  acceptWindowsLicenseTerms?: boolean;
  customScriptPath?: string;
  customScriptSha256?: string;
};

const sha256Pattern = /^[0-9a-f]{64}$/;
export function validWindowsVmImageOptions(options: WindowsVmImageOptions): boolean {
  const customPair = Boolean(options.customScriptPath?.trim()) === Boolean(options.customScriptSha256?.trim());
  if (!customPair || (options.customScriptSha256 && !sha256Pattern.test(options.customScriptSha256))) return false;
  if (options.source === "checkpoint") {
    return !options.sourcePath && !options.sourceSha256 && !options.imageName && !options.acceptWindowsLicenseTerms;
  }
  if (!options.sourcePath?.trim() || !options.sourceSha256 || !sha256Pattern.test(options.sourceSha256)) return false;
  if (options.source === "iso") return Boolean(options.imageName?.trim() && options.acceptWindowsLicenseTerms);
  return !options.imageName && !options.acceptWindowsLicenseTerms;
}


export function buildNpxJoinCommand(origin: string, code: string): string {
  return `npx --yes mars-worker-join@0.1.0 --control-plane-url ${new URL(origin).origin} --join-code ${code}`;
}

export function buildInstallerCommand(installer: string, audience: RuntimePlatform, code?: string, connectOrigin?: string, vmOptions?: WindowsVmImageOptions): string {
  if (!["linux-x64", "linux-arm64", "windows-x64", "macos-arm64"].includes(audience)) throw new Error("Unsupported installer audience");
  const url = new URL(installer);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Installer URL must use HTTP or HTTPS");
  const selectedOrigin = connectOrigin ? new URL(connectOrigin).origin : url.origin;
  const protocol = url.protocol.slice(0, -1);
  const tls = protocol === "https" ? " --tlsv1.3" : "";
  if (audience === "windows-x64" || audience === "linux-arm64") {
    const codeArg = code ? ` -Code ${quotePowerShell(code)}` : "";
    const insecureArg = selectedOrigin.startsWith("http:") && audience === "windows-x64" ? " -AllowInsecureHttp" : "";
    let vmArgs = "";
    if (audience === "windows-x64" && vmOptions && validWindowsVmImageOptions(vmOptions)) {
      vmArgs += ` -WindowsVmImageSource ${quotePowerShell(vmOptions.source)}`;
      if (vmOptions.source !== "checkpoint") {
        vmArgs += ` -WindowsSourcePath ${quotePowerShell(vmOptions.sourcePath!)} -WindowsSourceSha256 ${quotePowerShell(vmOptions.sourceSha256!)}`;
      }
      if (vmOptions.source === "iso") {
        vmArgs += ` -WindowsImageName ${quotePowerShell(vmOptions.imageName!)}`;
        if (vmOptions.acceptWindowsLicenseTerms) vmArgs += " -AcceptWindowsLicenseTerms";
      }
      if (vmOptions.customScriptPath) {
        vmArgs += ` -WindowsCustomProvisioningScriptPath ${quotePowerShell(vmOptions.customScriptPath)} -WindowsCustomProvisioningScriptSha256 ${quotePowerShell(vmOptions.customScriptSha256!)}`;
      }
    }
    const args = audience === "windows-x64" ? ` -ControlPlaneUrl ${quotePowerShell(selectedOrigin)}${vmArgs}${codeArg}${insecureArg}` : ` -ControlPlaneUrl ${quotePowerShell(selectedOrigin)}${codeArg}`;
    return `$marsInstaller = Join-Path $env:TEMP ("mars-installer-" + [guid]::NewGuid() + ".ps1")\ntry {\n  curl.exe --fail --proto '=${protocol}'${tls} --output $marsInstaller '${url}'\n  if ($LASTEXITCODE -ne 0) { throw "Installer download failed with exit code $LASTEXITCODE" }\n  powershell.exe -NoProfile -ExecutionPolicy Bypass -File $marsInstaller${args}\n} finally {\n  Remove-Item -LiteralPath $marsInstaller -Force -ErrorAction SilentlyContinue\n}`;
  }
  const shell = audience === "macos-arm64" ? "zsh" : "bash";
  const codeArg = code ? ` --code ${quoteShell(code)}` : "";
  const controlPlaneArg = ` --control-plane-url ${quoteShell(selectedOrigin)}`;
  const controlPlaneEnv = `PUBLIC_BASE_URL=${quoteShell(selectedOrigin)} `;
  return `set -e\nmarsInstaller="$(mktemp "\${TMPDIR:-/tmp}/mars-installer.XXXXXX")"\ntrap 'rm -f "$marsInstaller"' EXIT\ncurl --fail --proto '=${protocol}'${tls} --output "$marsInstaller" ${quoteShell(url.toString())}\n${controlPlaneEnv}${shell} "$marsInstaller"${controlPlaneArg}${codeArg}`;
}
export function buildInstallerCommands(origin: string, audience: RuntimePlatform, code?: string, vmOptions?: WindowsVmImageOptions): { label: string; command: string }[] {
  if (audience === "windows-x64" && vmOptions && !validWindowsVmImageOptions(vmOptions)) throw new Error("Windows VM image source fields are invalid");
  const labels: Record<RuntimePlatform, string> = { "linux-x64": "Linux x64", "linux-arm64": "Linux ARM64 (Docker Desktop)", "windows-x64": "Windows x64", "macos-arm64": "macOS arm64" };
  const selectedOrigin = new URL(origin).origin;
  const vmSource = audience === "windows-x64" && vmOptions ? `&vmSource=${vmOptions.source}` : "";
  const installer = `${selectedOrigin}/api/workers/installer?audience=${audience}${vmSource}&connectOrigin=${encodeURIComponent(selectedOrigin)}`;
  return [{ label: labels[audience], command: buildInstallerCommand(installer, audience, code, selectedOrigin, vmOptions) }];
}
export function normalizeControlPlaneUrls(values: readonly string[]): string[] {
  const valid = values.flatMap((value) => {
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") return [];
      return [url.origin];
    } catch {
      return [];
    }
  });
  return [...new Set(valid)];
}
type EnrollmentPanelProps = {
  workers: readonly WorkerConnection[];
  onConnected: (workerId: string) => void;
  showRotation?: boolean;
};

export function EnrollmentPanel({ workers, onConnected, showRotation = true }: EnrollmentPanelProps) {
  const [audience, setAudience] = useState<RuntimePlatform>("linux-x64");
  const [windowsVmSource, setWindowsVmSource] = useState<WindowsVmImageSource>("checkpoint");
  const [provisionWindowsVm, setProvisionWindowsVm] = useState(false);
  const [windowsSourcePath, setWindowsSourcePath] = useState("");
  const [windowsSourceSha256, setWindowsSourceSha256] = useState("");
  const [windowsImageName, setWindowsImageName] = useState("Windows 11 Pro");
  const [acceptWindowsLicenseTerms, setAcceptWindowsLicenseTerms] = useState(false);
  const [customScriptPath, setCustomScriptPath] = useState("");
  const [customScriptSha256, setCustomScriptSha256] = useState("");
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [status, setStatus] = useState<{ initialized: boolean } | null>(null);
  const [controlPlaneUrls, setControlPlaneUrls] = useState<string[]>([]);
  const [controlPlaneUrl, setControlPlaneUrl] = useState("");
  const [snapshot, setSnapshot] = useState<WorkerConnectionSnapshot | null>(null);
  const [connectedWorkerId, setConnectedWorkerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const load = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const [urls, bootstrap] = await Promise.all([getWorkerControlPlaneUrls(), getWorkerBootstrapStatus()]);
      const options = normalizeControlPlaneUrls(urls);
      setControlPlaneUrls(options);
      setControlPlaneUrl(options[0] ?? "");
      setStatus(bootstrap);
    } catch (reason) {
      setError(reason instanceof ApiRequestError ? reason.message : "Enrollment settings could not be loaded.");
    } finally {
      setPending(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!reveal || !snapshot || connectedWorkerId) return;
    const workerId = connectedEnrollmentWorker(snapshot, workers);
    if (!workerId) return;
    setConnectedWorkerId(workerId);
    onConnected(workerId);
  }, [connectedWorkerId, onConnected, reveal, snapshot, workers]);
  const selectedUrl = controlPlaneUrl;
  const validSelectedUrl = controlPlaneUrls.includes(selectedUrl);
  const vmOptions: WindowsVmImageOptions = {
    source: windowsVmSource,
    ...(windowsVmSource !== "checkpoint" ? { sourcePath: windowsSourcePath, sourceSha256: windowsSourceSha256 } : {}),
    ...(windowsVmSource === "iso" ? { imageName: windowsImageName, acceptWindowsLicenseTerms } : {}),
    ...(customScriptPath || customScriptSha256 ? { customScriptPath, customScriptSha256 } : {}),
  };
  const validSource = audience !== "windows-x64" || !provisionWindowsVm || windowsVmSource === "checkpoint" || validWindowsVmImageOptions(vmOptions);
  const commandBlocks = reveal && validSelectedUrl && validSource ? [
    ...(!provisionWindowsVm || audience !== "windows-x64" ? [{ label: "npx (default worker runtime)", command: buildNpxJoinCommand(selectedUrl, reveal.code) }] : []),
    ...buildInstallerCommands(selectedUrl, audience, reveal.code, provisionWindowsVm ? vmOptions : undefined),
  ] : [];
  async function create() {
    if (showRotation && status?.initialized && !window.confirm("Rotate the bootstrap code? The previous code will stop working immediately.")) return;
    setPending(true);
    setError(null);
    setSnapshot(connectionSnapshot(workers));
    try {
      setReveal(status?.initialized ? await rotateWorkerBootstrap() : await initializeWorkerBootstrap());
      setStatus({ initialized: true });
    } catch (reason) {
      setError(reason instanceof ApiRequestError ? reason.message : "Bootstrap code could not be generated.");
    } finally {
      setPending(false);
    }
  }
  function reset() {
    setReveal(null);
    setSnapshot(null);
    setConnectedWorkerId(null);
    setError(null);
  }
  return <section className="enrollment-panel" aria-labelledby="enrollment-title">
    <div className="panel-kicker">Worker enrollment</div>
    <h2 id="enrollment-title">Bring an appliance online</h2>
    {connectedWorkerId ? <div role="status"><h3>Worker connected</h3><p>The worker is ready for identity verification and selection.</p><Button label="Enroll another worker" variant="secondary" clickAction={reset} /></div> : <>
      <label>Target platform<select value={audience} onChange={(event) => setAudience(event.target.value as RuntimePlatform)}><option value="linux-x64">Linux x64</option><option value="linux-arm64">Linux ARM64 (Docker Desktop)</option><option value="windows-x64">Windows x64</option><option value="macos-arm64">macOS arm64</option></select></label>
      {audience === "windows-x64" && <><label><input type="checkbox" checked={provisionWindowsVm} onChange={(event) => setProvisionWindowsVm(event.target.checked)} />Provision a Hyper-V VM image during installation (optional)</label>{provisionWindowsVm && <><label>VM image provisioning source<select value={windowsVmSource} onChange={(event) => setWindowsVmSource(event.target.value as WindowsVmImageSource)}><option value="iso">Build from Windows ISO</option><option value="vhdx">Build from generalized VHDX</option><option value="checkpoint">Download prepared checkpoint</option></select></label>{windowsVmSource !== "checkpoint" && <><label>Local {windowsVmSource.toUpperCase()} path<input value={windowsSourcePath} onChange={(event) => setWindowsSourcePath(event.target.value)} /></label><label>Local {windowsVmSource.toUpperCase()} SHA-256<input value={windowsSourceSha256} onChange={(event) => setWindowsSourceSha256(event.target.value)} /></label>{windowsVmSource === "iso" && <><label>Windows image name<input value={windowsImageName} onChange={(event) => setWindowsImageName(event.target.value)} /></label><label><input type="checkbox" checked={acceptWindowsLicenseTerms} onChange={(event) => setAcceptWindowsLicenseTerms(event.target.checked)} />I confirm I am licensed to use this Windows media and accept its license terms</label></>}</>}<label>Custom provisioning script path (optional)<input value={customScriptPath} onChange={(event) => setCustomScriptPath(event.target.value)} /></label><label>Custom provisioning script SHA-256 (optional)<input value={customScriptSha256} onChange={(event) => setCustomScriptSha256(event.target.value)} /></label>{!validSource && <p className="form-error" role="alert">Complete the selected VM source fields using lowercase SHA-256 values.</p>}</>}</>}
      <label>Control-plane URL<select value={controlPlaneUrl} onChange={(event) => setControlPlaneUrl(event.target.value)}>{controlPlaneUrls.map((url) => <option key={url} value={url}>{url}</option>)}</select></label>
      {reveal ? <div><p><strong>Bootstrap code (showing once)</strong></p><code>{reveal.code}</code><p>Copy a command below and run it on the target machine. Review, configure, and approve the pending worker in the UI before it can receive jobs.</p>{commandBlocks.map(({ label, command: block }) => <div key={label}><h3>{label}</h3><pre>{block}</pre><Button label="Copy install command" variant="secondary" clickAction={() => void navigator.clipboard.writeText(block)} /></div>)}</div> : <div><p>Choose a target platform and approved control-plane URL, then generate a one-use bootstrap code.</p><Button label="Generate bootstrap code" variant="primary" clickAction={() => void create()} isDisabled={pending || !status || !validSelectedUrl || !validSource} /></div>}
    </>}
    {error && <div role="alert" className="form-error"><p>{error}</p>{!status && <Button label="Retry" variant="secondary" clickAction={() => void load()} isDisabled={pending} />}</div>}
  </section>;
}
