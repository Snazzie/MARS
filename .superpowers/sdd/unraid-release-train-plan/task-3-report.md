# Task 3 — Target-host delivery

## Status

Implemented and committed in this task-3 commit.

## Changes

- Linux installer consumes route-injected broker, QCOW2, Compose, and domain-template URLs plus SHA-256 values; verifies payload bytes and response hashes before startup; preserves Ubuntu 24.04 x64/KVM/libvirt, join-code, resume, and checkpoint flow; recursively assigns broker config, golden, clones, channels, and action-cache paths to `10001:10001`.
- Linux broker image creates UID/GID 10001 writable directories, exposes cache ports 8788/8789, and retains the non-root `linux-worker` entrypoint. Compose now requires control-plane URL, golden digest, libvirt network, and action-cache interpolation values and mounts host-owned persistent paths.
- Windows installer is container-only (no released VM/VHDX path). It validates and downloads orchestrator, service host, job agent, digest-pinned base metadata, runner, Git, VC runtime, image builder, verifier, Containerfile, and entrypoint before worker replacement; stages hashes, builds the local Windows job image, and retains protected join-code, resume/upgrade, SCM replacement, and enrollment behavior.
- Local Windows image builder accepts pre-downloaded verified archive paths, avoiding mutable rediscovery and registry publication.
- macOS installer verifies orchestrator, job agent, and preparation helper through route URLs/hashes before active-worker mutation; invokes the helper against the manifest's digest-pinned Tart source; installs LaunchAgent atomically only after local preparation and provenance succeed.
- macOS preparation helper supports `--output-manifest`, content-addressed staging, exact provenance (source/digest, job-agent hash, runner URL/version/hash, preparation-script hash, local target, logical prepared digest), idempotent matching reuse, and rollback-safe target replacement. It has no credential inputs or registry-secret output.
- WorkerActions now refuses upgrades for a reported non-container Windows runtime and keeps generated upgrades on `runtime=container`; focused regression test added.
- Development macOS route resolution now requires explicit orchestrator, job-agent, preparation helper, and digest-pinned Tart source assets; missing/partial local configuration returns structured unavailable responses instead of a nonfunctional 200 installer. Development macOS asset routes proxy those verified local files.

## Verification

- `bun test tests/installer-arguments.test.ts apps/web/src/components/EnrollmentPanel.test.ts apps/web/src/components/WorkerActions.test.tsx tests/linux-broker-container-contract.test.ts tests/windows-container-image-contract.test.ts`
- Result: **40 pass, 0 fail** (258 assertions).
- PowerShell parser checks passed for `deploy/workers/install-worker.ps1` and `deploy/workers/build-windows-container-image-local.ps1`.

## Concerns / limitations

- Actual macOS zsh/Tart and Windows Docker/Hyper-V execution were not available on this Windows development host; host-runtime proof remains a release-train/real-host responsibility.
- Existing project-wide tests outside the focused installer/container/UI set were not run per task scope.
