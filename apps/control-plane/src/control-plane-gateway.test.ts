import { expect, test } from "bun:test";

const gatewaySource = await Bun.file(new URL("./control-plane-gateway.ts", import.meta.url)).text();

test("starts worker heartbeat polling after authentication", () => {
  const authenticatedBranchStart = gatewaySource.indexOf('frame.type === "authenticate"');
  const doctorBranchStart = gatewaySource.indexOf('frame.type === "doctor"', authenticatedBranchStart);
  const authenticatedBranch = gatewaySource.slice(authenticatedBranchStart, doctorBranchStart);
  expect(authenticatedBranch).toContain('ws.send(JSON.stringify({ version: 1, type: "authenticated"');
  expect(authenticatedBranch).toContain('ws.send(JSON.stringify({ version: 1, type: "ping" }));');
});

test("workers answer heartbeat pings with JSON frames", async () => {
  for (const path of ["../../orchestrator/src/linux-agent.ts", "../../orchestrator/src/mac-agent.ts", "../../orchestrator/src/windows-agent.ts"]) {
    const source = await Bun.file(new URL(path, import.meta.url)).text();
    expect(source).toContain('ws.send(JSON.stringify({ version: 1, type: "pong", workerId: identity.workerId }))');
  }
});
