import { useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { ApiRequestError, getWorkerBootstrapStatus, getWorkerControlPlaneUrls, initializeWorkerBootstrap, rotateWorkerBootstrap } from "../api.ts";

type RuntimePlatform = "linux-x64" | "windows-x64" | "macos-arm64";
type Reveal = { code: string; generation: number; createdAt: string };

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
    return `$whitesmithInstaller = Join-Path $env:TEMP ("whitesmith-installer-" + [guid]::NewGuid() + ".ps1")\ntry {\n  curl.exe --fail --proto '=${protocol}'${tls} --output $whitesmithInstaller '${installer}'\n  if ($LASTEXITCODE -ne 0) { throw "Installer download failed with exit code $LASTEXITCODE" }\n  powershell.exe -NoProfile -ExecutionPolicy Bypass -File $whitesmithInstaller${codeArg}\n} finally {\n  Remove-Item -Force -ErrorAction SilentlyContinue $whitesmithInstaller\n}`;
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
export async function openEnrollmentDialog<T>(loadStatus: () => Promise<T>, showModal: () => void): Promise<T> {
  const status = await loadStatus();
  showModal();
  return status;
}

export function EnrollmentWizard({ onCreated, showRotation = true }: { onCreated: () => void; showRotation?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [audience, setAudience] = useState<RuntimePlatform>("linux-x64");
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [status, setStatus] = useState<{ initialized: boolean } | null>(null);
  const [controlPlaneUrls, setControlPlaneUrls] = useState<string[]>([]);
  const [controlPlaneUrl, setControlPlaneUrl] = useState("custom");
  const [customUrl, setCustomUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const selectedUrl = controlPlaneUrl === "custom" ? customUrl : controlPlaneUrl;
  const commandBlocks = reveal && selectedUrl ? buildInstallerCommands(selectedUrl, audience, reveal.code) : [];
  async function open() {
    setError(null);
    setReveal(null);
    setPending(true);
    try {
      const urls = await getWorkerControlPlaneUrls();
      const options = normalizeControlPlaneUrls(urls);
      setControlPlaneUrls(options);
      setControlPlaneUrl(options[0] ?? "custom");
      setStatus(await openEnrollmentDialog(getWorkerBootstrapStatus, () => dialog.current?.showModal()));
    } catch (reason) {
      setError(reason instanceof ApiRequestError ? reason.message : "Bootstrap status could not be loaded.");
    } finally {
      setPending(false);
    }
  }
  async function create() {
    if (showRotation && status?.initialized && !window.confirm("Rotate the bootstrap code? The previous code will stop working immediately.")) return;
    setPending(true);
    setError(null);
    try {
      setReveal(status?.initialized ? await rotateWorkerBootstrap() : await initializeWorkerBootstrap());
    } catch (reason) {
      setError(reason instanceof ApiRequestError ? reason.message : "Bootstrap code could not be generated.");
    } finally {
      setPending(false);
    }
  }
  function close() { dialog.current?.close(); if (reveal) onCreated(); setReveal(null); }
  return <><Button label="Enroll worker" variant="primary" clickAction={() => void open()} isDisabled={pending} /><dialog ref={dialog} className="enrollment-dialog" onCancel={close} aria-labelledby="enrollment-title"><div className="panel-kicker">Worker enrollment</div><h2 id="enrollment-title">Bring an appliance online</h2>{reveal ? <section><label>Control-plane URL<select value={controlPlaneUrl} onChange={(event) => { setControlPlaneUrl(event.target.value); if (event.target.value !== "custom") setCustomUrl(""); }}>{controlPlaneUrls.map((url) => <option key={url} value={url}>{url}</option>)}<option value="custom">Custom URL</option></select></label>{controlPlaneUrl === "custom" && <label>Custom base URL<input value={customUrl} onChange={(event) => setCustomUrl(event.target.value)} placeholder="http://192.168.64.1:3000" /></label>}<p><strong>Bootstrap code (showing once)</strong></p><code>{reveal.code}</code><p>Copy one command for the target platform. Closing this window clears the code.</p>{commandBlocks.map(({ label, command: block }) => <div key={label}><h3>{label}</h3><pre>{block}</pre><Button label="Copy install command" variant="secondary" clickAction={() => void navigator.clipboard.writeText(block)} /></div>)}<Button label="Close" variant="secondary" clickAction={close} /></section> : <section><p>Choose a target platform, then generate a one-use bootstrap code.</p><label>Target platform<select value={audience} onChange={(event) => setAudience(event.target.value as RuntimePlatform)}><option value="linux-x64">Linux x64</option><option value="windows-x64">Windows x64</option><option value="macos-arm64">macOS arm64</option></select></label><Button label="Generate bootstrap code" variant="primary" clickAction={() => void create()} isDisabled={pending || !status} /></section>}{error && <p role="alert" className="form-error">{error}</p>}</dialog></>;
}
