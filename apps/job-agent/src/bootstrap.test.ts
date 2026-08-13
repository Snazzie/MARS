import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOneTimeJitBootstrap } from "./bootstrap.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("starts run.sh from the supplied Actions Runner root", async () => {
  const root = await mkdtemp(join(tmpdir(), "whitesmith-job-agent-"));
  roots.push(root);
  const configPath = join(root, "jit-config");
  const outputPath = join(root, "received-config");
  await writeFile(configPath, "encoded-jit-config\n", { mode: 0o600 });
  await writeFile(join(root, "run.sh"), `#!/bin/sh\nprintf '%s' "$ACTIONS_RUNNER_INPUT_JITCONFIG" > '${outputPath}'\nprintf 'runner-output\\n'\n`, { mode: 0o700 });
  await chmod(join(root, "run.sh"), 0o700);

  await runOneTimeJitBootstrap(configPath, root);

  expect(await Bun.file(outputPath).text()).toBe("encoded-jit-config");
  expect(await Bun.file(configPath).exists()).toBe(false);
});
