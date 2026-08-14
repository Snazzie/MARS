# Opt-in Dev Port Cleanup Design

## Decision

`bun dev --kill` terminates processes listening on the configured control-plane and web development ports before startup. Plain `bun dev` remains non-destructive.

## Behavior

A Bun startup script resolves `PORT` and `WEB_PORT`, defaulting to `3000` and `5173`. On Windows it queries listening TCP owners with PowerShell, prints each PID, force-stops only those owners, and fails if either port remains occupied. Duplicate PIDs are killed once. The current process and invalid/system PID zero are never targets.

After optional cleanup, the script runs `build:windows-worker` and starts the existing control-plane and Vite commands under `concurrently`. Unknown command-line options fail instead of leaking into child commands.

## Verification

Unit tests cover option parsing, default/configured ports, PowerShell command construction, duplicate ports, and unknown arguments. A Windows smoke test starts a disposable listener, runs the cleanup helper, and confirms the listener exits and the port can be rebound.
