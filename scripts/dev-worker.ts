export function developmentWorkerScript(platform: NodeJS.Platform, arch: string): "./dev-windows-worker.ts" | "./dev-mac-worker.ts" {
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) return "./dev-windows-worker.ts";
  if (platform === "darwin" && arch === "arm64") return "./dev-mac-worker.ts";
  throw new Error(`Development worker is unsupported on ${platform}/${arch}`);
}

// Load only the current host's launcher; the other requires platform-specific tooling.
if (import.meta.main) await import(developmentWorkerScript(process.platform, process.arch));
