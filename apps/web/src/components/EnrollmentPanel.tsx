import { useCallback, useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { ApiRequestError, getWorkerBootstrapStatus, getWorkerControlPlaneUrls, initializeWorkerBootstrap, rotateWorkerBootstrap } from "../api.ts";

type RuntimePlatform = "linux-x64" | "windows-x64" | "macos-arm64";
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

export function buildInstallerCommand(installer: string, audience: RuntimePlatform, code?: string): string {
  if (!["linux-x64", "windows-x64", "macos-arm64"].includes(audience)) throw new Error("Unsupported installer audience");
  const url = new URL(installer);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Installer URL must use HTTP or HTTPS");
  const protocol = url.protocol.slice(0, -1);
  const tls = protocol === "https" ? " --tlsv1.3" : "";
  if (audience === "windows-x64") {
    const codeArg = code ? ` -Code ${quotePowerShell(code)}` : "";
    const insecureArg = protocol === "http" ? " -AllowInsecureHttp" : "";
    return `$whitesmithInstaller = Join-Path $env:TEMP ("whitesmith-installer-" + [guid]::NewGuid() + ".ps1")\ntry {\n  curl.exe --fail --proto '=${protocol}'${tls} --output $whitesmithInstaller '${installer}'\n  if ($LASTEXITCODE -ne 0) { throw "Installer download failed with exit code $LASTEXITCODE" }\n  powershell.exe -NoProfile -ExecutionPolicy Bypass -File $whitesmithInstaller${codeArg}${insecureArg}\n} finally {\n  Remove-Item -Force -ErrorAction SilentlyContinue $whitesmithInstaller\n}`;
  }
  const shell = audience === "macos-arm64" ? "zsh" : "bash";
  const codeArg = code ? ` -- --code ${quoteShell(code)}` : "";
  return `curl --fail --proto '=${protocol}'${tls} ${quoteShell(installer)} | ${shell} -s${codeArg}`;
}

export function buildInstallerCommands(origin: string, audience: RuntimePlatform, code?: string): { label: string; command: string }[] {
  const labels: Record<RuntimePlatform, string> = { "linux-x64": "Linux x64", "windows-x64": "Windows x64", "macos-arm64": "macOS arm64" };
  return [{ label: labels[audience], command: buildInstallerCommand(`${origin}/api/workers/installer?audience=${audience}`, audience, code) }];
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
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [status, setStatus] = useState<{ initialized: boolean } | null>(null);
  const [controlPlaneUrls, setControlPlaneUrls] = useState<string[]>([]);
  const [controlPlaneUrl, setControlPlaneUrl] = useState("custom");
  const [customUrl, setCustomUrl] = useState("");
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
      setControlPlaneUrl(options[0] ?? "custom");
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
  const defaultControlPlaneUrl = typeof window === "undefined" ? "" : window.location.origin;
  const selectedUrl = controlPlaneUrl === "custom" ? (customUrl.trim() || controlPlaneUrls[0] || defaultControlPlaneUrl) : controlPlaneUrl;
  const usingDefaultUrl = controlPlaneUrl === "custom" && !customUrl.trim();
  const validSelectedUrl = /^https?:\/\/[^/]+/i.test(selectedUrl);
  const commandBlocks = reveal && validSelectedUrl ? buildInstallerCommands(selectedUrl, audience, reveal.code) : [];
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
  return <section className="enrollment-panel" aria-labelledby="enrollment-title"><div className="panel-kicker">Worker enrollment</div><h2 id="enrollment-title">Bring an appliance online</h2>{connectedWorkerId ? <div role="status"><h3>Worker connected</h3><p>The worker is ready for identity verification and selection.</p><Button label="Enroll another worker" variant="secondary" clickAction={reset} /></div> : <><label>Target platform<select value={audience} onChange={(event) => setAudience(event.target.value as RuntimePlatform)}><option value="linux-x64">Linux x64</option><option value="windows-x64">Windows x64</option><option value="macos-arm64">macOS arm64</option></select></label><label>Control-plane URL<select value={controlPlaneUrl} onChange={(event) => { setControlPlaneUrl(event.target.value); if (event.target.value !== "custom") setCustomUrl(""); }}>{controlPlaneUrls.map((url) => <option key={url} value={url}>{url}</option>)}<option value="custom">Custom URL</option></select></label>{controlPlaneUrl === "custom" && <label>Custom base URL<input value={customUrl} onChange={(event) => setCustomUrl(event.target.value)} placeholder="http://192.168.64.1:3000" /></label>}{reveal ? <div><p><strong>Bootstrap code (showing once)</strong></p><code>{reveal.code}</code>{usingDefaultUrl ? <p>Using default control-plane URL: <code>{selectedUrl}</code></p> : <p>Copy the command below and run it on the target machine.</p>}{commandBlocks.map(({ label, command: block }) => <div key={label}><h3>{label}</h3><pre>{block}</pre><Button label="Copy install command" variant="secondary" clickAction={() => void navigator.clipboard.writeText(block)} /></div>)}</div> : <div><p>Choose a target platform and control-plane URL, then generate a one-use bootstrap code.</p><Button label="Generate bootstrap code" variant="primary" clickAction={() => void create()} isDisabled={pending || !status || !validSelectedUrl} /></div>}</>}{error && <div role="alert" className="form-error"><p>{error}</p>{!status && <Button label="Retry" variant="secondary" clickAction={() => void load()} isDisabled={pending} />}</div>}</section>;
}
