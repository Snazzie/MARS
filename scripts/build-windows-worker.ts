if (process.platform !== "win32") process.exit(0);

const commands = [
  ["bun", "run", "--filter", "@whitesmith/orchestrator", "build"],
  ["cargo", "build", "--release", "--manifest-path", "apps/windows-service-host/Cargo.toml"],
];

for (const command of commands) {
  const build = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const exitCode = await build.exited;
  if (exitCode !== 0) process.exit(exitCode);
}
