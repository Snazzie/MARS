# Task 5 report

## Status
Implemented strict `--code <43-character-base64url>` parsing for Linux/macOS installers and mandatory validated `-Code` PowerShell parameter for Windows. Invalid arguments fail before platform checks; code handoff uses stdin and cleanup clears secrets.

## Verification
- `bun test tests/installer-arguments.test.ts` — 4 pass, 0 fail, 34 assertions.
- `bash -n deploy/workers/install-worker.sh && zsh -n deploy/workers/install-worker-macos.sh && git diff --check` — passed.

## Notes
Linux CIDATA generation reads the enrollment code from stdin rather than exposing it as a Python argument. macOS invokes the existing orchestrator `--code-stdin` handoff. Windows invokes the orchestrator with piped code and clears `$Code` in `finally`; no `Read-Host` prompt remains.

## Windows failure hardening
Commit `091ab0e` checks the native orchestrator process exit code and removes/stops the newly created VM on join failure; temporary code material is removed in `finally`, and success is not printed after a failed join. Static coverage was added.

## Final review hardening
Commit `8675641` adds join dispatch to the actual orchestrator index entrypoint and replaces Windows temporary-file stdin redirection with in-memory `ProcessStartInfo` stdin. Focused tests now cover entrypoint dispatch and secret-safe failure cleanup.

## TLS and timeout hardening
Commit `af694a9` rejects non-HTTPS remote control-plane URLs (only explicit localhost HTTP is allowed), bounds join HTTP/process waits to 30 seconds, and preserves VM cleanup on timeout. Focused tests cover policy and timeout contracts.
