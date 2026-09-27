## Windows worker capabilities

Windows workers enroll in discovery-only mode. Their doctor report advertises **verified** runtime capabilities; configuration selects exactly one. An advertised mode never runs jobs until explicitly selected and acknowledged. Pool creation and scheduling require the selected driver, matching guest platform and immutable image/checkpoint digest, fresh doctor evidence, and a ready configuration revision. The first configuration of an approved but unconfigured worker does not require draining; changing an existing selection requires draining the worker and waiting for active leases to finish.

The Windows worker reports the physical Windows CPU architecture (`windows-x64` or `windows-arm64`), not the architecture of its executable under emulation or its Docker engine. Windows ARM64 hosts can select only a verified Linux ARM64 Docker guest; Windows x64 containers and Hyper-V VM checkpoints are not advertised as supported there. An already-enrolled ARM64 host previously labeled `windows-x64` is corrected by its next authenticated doctor report after updating the worker and control plane. That correction clears its old runtime configuration and drains the worker; configure a ready Linux ARM64 capability and undrain it before scheduling jobs. The current release catalog has no Windows ARM64 worker upgrade artifact.

| Selection | Guest | Requirement | Isolation boundary |
| --- | --- | --- | --- |
| Docker Linux | Linux x64 or ARM64 (native engine architecture) | Active Linux Docker engine; matching digest-pinned `MARS_LINUX_X64_CONTAINER_IMAGE` or `MARS_LINUX_ARM64_CONTAINER_IMAGE` from the Linux job image, verified entrypoint and `MARS_LINUX_CONTAINER_NETWORK` (default `mars-linux-x64` or `mars-linux-arm64`) | Docker Linux container |
| Docker Windows (process isolation) | Windows x64 | Active Windows Docker engine, verified Windows job image and passing process-isolation probe | **Shares the host kernel; weaker boundary than Hyper-V. Explicit opt-in only.** |
| Docker Windows + Hyper-V isolation | Windows x64 | Active Windows Docker engine, verified Windows job image and passing Hyper-V-isolation probe | Hyper-V isolated container |
| Windows Hyper-V VM | Windows x64 | Hyper-V host, configured switch and installed, verified checkpoint | Hyper-V VM |

Docker engine selection is operator-managed. The worker never switches engines. It discovers and advertises the **currently active** Linux Docker engine (including ARM64) even if no job image is configured; the capability is then **not ready** with remediation until its architecture-matched, digest-pinned job image and network pass verification. After changing engines, refresh the worker doctor before selecting another mode. Prepare or pull the immutable matching image explicitly on the host and set its reference in the worker service environment; selection does not download an image. An absent image, daemon or checkpoint cannot produce a ready mode. Process isolation is never a fallback for Hyper-V.

Linux job containers are lease-scoped: the worker removes them after the runner exits (including failed runs), so an empty `docker ps -a` does not prove a Docker integration failure. Check the lease's `runner.finished` exit code and diagnostic chunks in the control plane. Images built with the updated guest agent preserve a nonzero runner exit code; previously built images may report zero instead. To inspect a container after failure, enable lease preservation for debugging before reproducing, then disable it and clean up the retained container. Rebuild and republish the pinned job image to include guest-agent fixes; changing the Windows worker alone does not update the executable inside the image.

On a Windows host running a Linux Docker guest, a zero `runner.finished` exit code only says the runner process exited successfully; it does not prove GitHub assigned or completed the job. The worker forwards the container's Docker logs and runner diagnostic bundle as `diagnostic.chunk` events after exit. If lease preservation is enabled, it deliberately emits `lease.failed` with `debug_preserve` after `runner.finished` and leaves the container in place; inspect that container's logs, then disable preservation and remove the retained container before scheduling more jobs. An older worker without diagnostic forwarding needs an updated worker process to provide those chunks.

The Linux ARM64 job image must include Ubuntu's `libicu74`: the .NET Actions Runner aborts before creating a new `_diag` log when ICU is absent. The image build runs `Runner.Listener --version` to catch that missing runtime dependency. A worker doctor report validates the image digest and entrypoint, not all of the runner's shared libraries. Rebuild and publish a new immutable job-image digest, update the worker's `MARS_LINUX_ARM64_CONTAINER_IMAGE` and its pool image digest, then refresh the worker's configuration; a `git pull` or worker restart does not alter the previously pinned image.

The installer downloads the worker independently of the runtime and does not install Docker, enable host features or switch the active engine. Optional provisioning inputs may prepare a Windows job image on an already-active Windows engine or provision a Hyper-V checkpoint. Upgrades retain both provisioned artifacts and service settings. Existing `-WindowsRuntime` arguments are provisioning inputs for older automation, not the selected execution mode.

To prepare a Windows VM checkpoint once:

```powershell
bun run setup:windows-hyperv-checkpoint
```

Configure the control plane's `MARS_WINDOWS_CHECKPOINT_PATH` or `MARS_WINDOWS_CHECKPOINT_URL` and `MARS_WINDOWS_CHECKPOINT_SHA256`. For VM execution the worker host requires Windows 11 Pro/Enterprise, Hyper-V, Administrator access and a usable virtual switch; set `MARS_HYPERV_SWITCH_NAME` if `Default Switch` is unsuitable. The installed checkpoint must pass its immutable manifest and guest probe verification.
