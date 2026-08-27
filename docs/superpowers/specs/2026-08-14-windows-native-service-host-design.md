# Windows Native Service Host Design

## Problem

`mars-orchestrator.exe windows-worker --service` is a console process. The current JavaScript `startWindowsService` function emits lifecycle states only to no-op hooks and never calls the Windows Service Control Manager (SCM). SCM therefore times out after 30 seconds with events 7009 and 7000.

## Decision

Ship a small unsigned native Windows service host for local development. The host is a Rust Win32 executable with no runtime installation requirement. Production signing remains a release-policy requirement, not a functional prerequisite.

## Runtime contract

SCM starts `mars-service-host.exe` with two arguments: the absolute orchestrator path and `windows-worker`. The host registers `MarsWorker` with SCM, reports `START_PENDING`, launches the orchestrator as a child in a Windows Job Object, then reports `RUNNING`.

The host inherits machine-scoped worker configuration and redirects child stdout/stderr to `C:\ProgramData\Mars\logs\worker.log`. A stop or shutdown control reports `STOP_PENDING`, terminates the Job Object so no child processes survive, waits for cleanup, and reports `STOPPED`. Unexpected child exit terminates the host with a failure code so the configured SCM recovery policy restarts it.

## Distribution and installation

The control plane serves the service-host artifact from a Windows-only endpoint beside the orchestrator artifact. The Windows installer downloads both executables into `C:\Program Files\Mars`, registers the native host with `New-Service`, and passes the orchestrator path in the service command line. The orchestrator runs its ordinary `windows-worker` entrypoint; the fake `--service` mode and JavaScript lifecycle shim are removed.

The installed directory and executables remain readable/executable only by SYSTEM and Administrators through inherited Program Files ACLs. Local HTTP remains permitted only by the existing explicit development opt-in. Production distribution requires HTTPS and Authenticode signing.

## Build

A dedicated Rust crate builds `mars-service-host.exe`. It uses `windows-sys` for Win32 bindings and the bundled Rust LLVM linker. The repository build command emits the artifact under the service-host crate's `dist` directory. A Windows CI workflow can reproduce the same artifact without Visual Studio.

## Failure handling

Installation fails immediately if the host artifact is unavailable, either download fails, service registration fails, recovery configuration fails, or SCM cannot reach `Running`. The installer includes recent Service Control Manager events and the worker log in its startup error so failures do not collapse into a generic `Start-Service` message.

## Verification

Tests cover service command construction, artifact routing, installer failure handling, and removal of the fake JavaScript service mode. Native tests cover command-line parsing and state mapping. A Windows smoke check builds the host, launches its non-SCM diagnostic mode to validate child supervision, installs a temporary test service when elevated, confirms `Running`, stops it, and confirms the child process tree exits.
