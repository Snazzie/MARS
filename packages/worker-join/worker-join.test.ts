import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./bin/mars-worker-join.mjs', import.meta.url));
const code = 'a'.repeat(43);
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

test('rejects malformed inputs without exposing the join code', () => {
  for (const origin of ['http://example.com', 'https://example.com/path', 'https://user@example.com', 'https://example.com?x=1']) {
    const result = run('--control-plane-url', origin, '--join-code', code);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain(code);
  }
  for (const args of [['--join-code', 'short'], ['--join-code', code, '--join-code', code], ['--unknown', code]]) {
    const result = run('--control-plane-url', 'http://localhost:1234', ...args);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain(code);
  }
});

test('downloads the selected installer and cleans up after execution', async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => { requests.push(req.url ?? ''); res.end('harmless installer fixture'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture address');
  const origin = `http://127.0.0.1:${address.port}`;
  const directory = mkdtempSync(join(tmpdir(), 'mars-cli-test-'));
  const output = join(directory, 'args.json');
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    requests.push(req.url ?? '');
    res.end(`param([string]$ControlPlaneUrl, [string]$Code)\n@($PSCommandPath, $ControlPlaneUrl, $Code) | ConvertTo-Json | Set-Content -LiteralPath $env:MARS_TEST_OUTPUT\nWrite-Output 'fixture ran'`);
  });
  try {
    // A child process is required so the synchronous CLI cannot block the fixture server.
    const result = await new Promise<{ status: number | null; stderr: string }>(resolve => {
      const child = Bun.spawn([process.execPath, cli, '--control-plane-url', origin, '--join-code', code], { env: { ...process.env, MARS_TEST_OUTPUT: output }, stdout: 'pipe', stderr: 'pipe' });
      Promise.all([child.exited, new Response(child.stderr).text()]).then(([status, stderr]) => resolve({ status, stderr }));
    });
    expect(result.status).toBe(0, result.stderr);
    expect(result.stderr).not.toContain(code);
    expect(requests).toEqual([`/api/workers/installer?audience=windows-x64&connectOrigin=${encodeURIComponent(origin)}`]);
    const args = JSON.parse(readFileSync(output, 'utf8'));
    expect(args[1]).toBe(origin);
    expect(args[2]).toBe(code);
    expect(() => readFileSync(args[0])).toThrow();
  } finally { server.close(); rmSync(directory, { recursive: true, force: true }); }
});
