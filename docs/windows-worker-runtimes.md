## Windows worker runtimes

Windows x64 workers support two explicit, non-fallback runtime modes:

- **Docker / Windows containers** uses the existing digest-pinned local image and
  mandatory Hyper-V container isolation.
- **Hyper-V VM** imports a generated-ID clone of the verified saved checkpoint
  for each lease. Docker is not installed or used by this mode.

Choose the runtime in the dashboard's Windows enrollment panel. The generated
PowerShell command passes `-WindowsRuntime 'container'` or `-WindowsRuntime 'vm'`;
upgrades preserve that selection.

The VM mode requires Windows 11 Pro or Enterprise, Hyper-V, Administrator access,
and a usable virtual switch. It uses `Default Switch` unless
`MARS_HYPERV_SWITCH_NAME` is set on the worker host before installation.

Prepare the signed-in Mars-ready checkpoint once:

```powershell
bun run setup:windows-hyperv-checkpoint
```

The command exports the newest Standard checkpoint, creates
`windows-worker-checkpoint.zip`, creates a digest-identical local backup, and
prints the artifact SHA-256. Configure the control plane with
`MARS_WINDOWS_CHECKPOINT_PATH` or `MARS_WINDOWS_CHECKPOINT_URL` and
`MARS_WINDOWS_CHECKPOINT_SHA256`. Production release manifests expose the same
artifact as `windows.vm.checkpoint`. Worker setup downloads and verifies the ZIP
once, then imports isolated checkpoint clones for jobs.

