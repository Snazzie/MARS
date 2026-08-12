import { useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { ApiRequestError, getWorkerBootstrapStatus, initializeWorkerBootstrap, rotateWorkerBootstrap } from "../api.ts";

type RuntimePlatform = "linux-x64" | "windows-x64" | "macos-arm64";
type Reveal = { code: string; generation: number; createdAt: string };

function quoteShell(value: string): string { return `'${value.replaceAll("'", "'\"'\"'")}'`; }
function quotePowerShell(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

export function buildInstallerCommand(installer: string, audience: RuntimePlatform, code?: string): string {
  if (!["linux-x64", "windows-x64", "macos-arm64"].includes(audience)) throw new Error("Unsupported installer audience");
  const url = new URL(installer);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("Installer URL must use HTTPS unless it targets loopback");
  const protocol = url.protocol.slice(0, -1);
  const tls = protocol === "https" ? " --tlsv1.3" : "";
  if (audience === "windows-x64") {
    const codeArg = code ? ` -Code ${quotePowerShell(code)}` : "";
    return `$whitesmithInstaller = Join-Path $env:TEMP ("whitesmith-installer-" + [guid]::NewGuid() + ".ps1")\ntry {\n  curl.exe --fail --proto '=${protocol}'${tls} --output $whitesmithInstaller '${installer}'\n  if ($LASTEXITCODE -ne 0) { throw "Installer download failed with exit code $LASTEXITCODE" }\n  powershell.exe -NoProfile -ExecutionPolicy Bypass -File $whitesmithInstaller${codeArg}\n} finally {\n  Remove-Item -Force -ErrorAction SilentlyContinue $whitesmithInstaller\n}`;
  }
  const shell = audience === "macos-arm64" ? "zsh" : "bash";
  const codeArg = code ? ` --code ${quoteShell(code)}` : "";
  return `whitesmith_installer="$(mktemp)" &&\ncurl --fail --proto '=${protocol}'${tls} --output "$whitesmith_installer" '${installer}'\nwhitesmith_status=$?\nif [ "$whitesmith_status" -eq 0 ]; then\n  ${shell} "$whitesmith_installer"${codeArg}\n  whitesmith_status=$?\nfi\nrm -f "\${whitesmith_installer:-}"\n(exit "$whitesmith_status")`;
}

export function buildInstallerCommands(origin: string, audience: RuntimePlatform, code?: string): { label: string; command: string }[] {
  const labels: Record<RuntimePlatform, string> = { "linux-x64": "Linux x64", "windows-x64": "Windows x64", "macos-arm64": "macOS arm64" };
  return [{ label: labels[audience], command: buildInstallerCommand(`${origin}/api/workers/installer?audience=${audience}`, audience, code) }];
}

export function EnrollmentWizard({ onCreated }: { onCreated: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [audience, setAudience] = useState<RuntimePlatform>("linux-x64");
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [status, setStatus] = useState<{ initialized: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const commandBlocks = reveal ? buildInstallerCommands(window.location.origin, audience, reveal.code) : [];
  async function create() { if (status?.initialized && !window.confirm("Rotate the bootstrap code? The previous code will stop working immediately.")) return; setPending(true); setError(null); try { setReveal(status?.initialized ? await rotateWorkerBootstrap() : await initializeWorkerBootstrap()); } catch (reason) { setError(reason instanceof ApiRequestError ? reason.message : "Bootstrap code could not be generated."); } finally { setPending(false); } }
  function close() { dialog.current?.close(); if (reveal) onCreated(); setReveal(null); }
  return <><Button label="Enroll worker" variant="primary" clickAction={() => void open()} isDisabled={pending} /><dialog ref={dialog} className="enrollment-dialog" onCancel={close} aria-labelledby="enrollment-title"><div className="panel-kicker">Worker enrollment</div><h2 id="enrollment-title">Bring an appliance online</h2>{reveal ? <section><p><strong>Bootstrap code (showing once)</strong></p><code>{reveal.code}</code><p>Copy one command for the target platform. Closing this window clears the code.</p>{commandBlocks.map(({ label, command: block }) => <div key={label}><h3>{label}</h3><pre>{block}</pre><Button label="Copy install command" variant="secondary" clickAction={() => void navigator.clipboard.writeText(block)} /></div>)}<Button label="Close" variant="secondary" clickAction={close} /></section> : <section><p className="muted">Generate a one-use bootstrap code. It is never stored in the browser or URL.</p><label>Platform<select value={audience} onChange={(event) => setAudience(event.target.value as RuntimePlatform)}><option value="linux-x64">Linux x64 · Kata appliance</option><option value="windows-x64">Windows x64 · Hyper-V appliance</option><option value="macos-arm64">macOS arm64 · Tart appliance</option></select></label>{status?.initialized ? <p>This bootstrap is already initialized. Rotating it invalidates the previous code.</p> : null}<Button label={status?.initialized ? "Rotate bootstrap code" : "Initialize worker bootstrap"} variant="primary" clickAction={() => void create()} isDisabled={pending} />{error ? <p role="alert">{error}</p> : null}</section>}</dialog></>;;
}
