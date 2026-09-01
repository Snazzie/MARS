# Timestamped Control-Plane Logs

## Problem

The control plane emits runtime messages through direct `console.log`, `console.warn`, and `console.error` calls. Persisted entries written to `control-plane-error.log` already include an ISO 8601 timestamp, but terminal output does not. Untimestamped terminal messages make event ordering and incident diagnosis harder.

## Goals

- Add timestamps to all control-plane console output.
- Use one machine-readable ISO 8601 format for `log`, `warn`, and `error`.
- Preserve existing messages, structured values, and `Error` details.
- Preserve the existing persisted error-log behavior.
- Keep the change localized without migrating every call site to a new logger abstraction.

## Non-goals

- Change worker-side logging behavior outside the control plane.
- Add log levels, rotation, retention, or external log shipping.
- Change the existing `control-plane-error.log` file location or error-only scope.
- Introduce a third-party logging dependency.

## Design

### Console output

At control-plane startup, wrap the three console methods used by runtime logging: `console.log`, `console.warn`, and `console.error`. Each emitted entry receives a prefix generated immediately before forwarding the call:

```text
2026-09-01T12:34:56.789Z <existing log arguments>
```

The timestamp MUST be produced with `new Date().toISOString()` and MUST precede the original first argument. Existing additional arguments remain separate arguments so structured objects and errors retain their runtime inspection behavior.

The wrapper MUST forward to the original bound console method and MUST preserve the original `this` context. It MUST not throw if timestamp formatting or file persistence fails.

### Persisted errors

`configureErrorFileLogging` continues to intercept `console.error`, forward the original error to the terminal, and append a single-line serialized entry to `control-plane-error.log`. The file entry retains its current ISO timestamp prefix and serialized `Error` stack/message details.

Because the terminal timestamp wrapper and file persistence wrapper both affect `console.error`, installation order MUST ensure each error is forwarded once to the original console and persisted once. The implementation SHOULD share a small internal formatter/wrapper rather than duplicating nested interception logic.

### Test isolation

Tests that install logging behavior MUST restore the exact prior console methods in `finally` blocks. The logging setup MUST not permanently mutate global console methods after the test completes.

## Data flow

1. Control-plane startup installs timestamped wrappers around console logging methods.
2. A runtime call invokes `console.log`, `console.warn`, or `console.error`.
3. The wrapper prepends the current ISO timestamp and forwards all arguments.
4. Error calls additionally serialize and append the entry to `control-plane-error.log`.
5. Logging failures do not mask the original application error.

## Tests

Add focused tests proving:

- `console.log` output receives an ISO timestamp and preserves additional arguments.
- `console.warn` output receives an ISO timestamp.
- persisted errors retain an ISO timestamp, message, and `Error` details.
- logging setup can be restored without leaving global console mutations.

Tests SHOULD inject or mock the clock only if needed to avoid brittle wall-clock assertions; otherwise assert the timestamp shape rather than an exact instant.

## Acceptance criteria

- Every control-plane `console.log`, `console.warn`, and `console.error` entry emitted after setup begins with an ISO 8601 timestamp.
- Existing log arguments and error details remain observable.
- `control-plane-error.log` continues to contain timestamped error entries.
- A failure while writing the log file does not hide the original console error.
- Focused logging tests pass without leaking console patches into other tests.
