if (process.platform !== "win32") process.exit(0);

const build = Bun.spawn([
  "cargo",
  "build",
  "--release",
  "--manifest-path",
  "apps/windows-service-host/Cargo.toml",
], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });

process.exit(await build.exited);
