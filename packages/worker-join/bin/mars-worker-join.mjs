#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const usage = 'Usage: mars-worker-join --control-plane-url <origin> --join-code <code>';
const audiences = {
  'win32/x64': 'windows-x64',
  'win32/arm64': 'linux-arm64',
  'linux/x64': 'linux-x64',
  'darwin/arm64': 'macos-arm64',
};

function argumentsFrom(argv) {
  if (argv.length === 1 && argv[0] === '--help') return null;
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!['--control-plane-url', '--join-code'].includes(key) || options.has(key) || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error(`Invalid arguments. ${usage}`);
    }
    options.set(key, argv[index + 1]);
  }
  if (options.size !== 2) throw new Error(`Missing arguments. ${usage}`);
  const code = options.get('--join-code');
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new Error('Invalid join code');
  const input = options.get('--control-plane-url');
  let url;
  try { url = new URL(input); } catch { throw new Error('Invalid control-plane URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Control-plane URL must be an HTTPS origin (HTTP allowed only on loopback)');
  }
  return { origin: url.origin, code };
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  if (!options) { console.log(usage); return 0; }
  const audience = audiences[`${process.platform}/${process.arch}`];
  if (!audience) throw new Error('Unsupported worker host');
  const url = new URL('/api/workers/installer', options.origin);
  url.searchParams.set('audience', audience);
  url.searchParams.set('connectOrigin', options.origin);
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'manual' });
  if (!response.ok) throw new Error(`Installer unavailable (HTTP ${response.status})`);
  const script = await response.text();
  if (!script.trim()) throw new Error('Installer response is empty');

  const directory = await mkdtemp(join(tmpdir(), 'mars-worker-join-'));
  try {
    if (process.platform !== 'win32') await (await import('node:fs/promises')).chmod(directory, 0o700);
    const scriptPath = join(directory, process.platform === 'win32' ? 'installer.ps1' : 'installer.sh');
    await writeFile(scriptPath, script, { mode: 0o600 });
    const windows = process.platform === 'win32';
    const command = windows ? 'powershell.exe' : process.platform === 'darwin' ? 'zsh' : 'bash';
    const args = windows
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-ControlPlaneUrl', options.origin, '-Code', options.code]
      : [scriptPath, '--control-plane-url', options.origin, '--code', options.code];
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: 'inherit', shell: false });
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
    });
    if (exitCode === 0) console.log('Worker installation started; review and approve the pending worker in the control-plane UI.');
    return exitCode;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`Worker join failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  process.exitCode = 1;
}
