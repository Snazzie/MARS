# Timestamped Control-Plane Logs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prefix control-plane `console.log`, `console.warn`, and `console.error` output with ISO 8601 timestamps while preserving existing arguments and error-file persistence.

**Architecture:** Keep the existing error-file interceptor responsible only for forwarding and persisting errors. Add a small console timestamp installer in `apps/control-plane/src/index.ts` that captures the current methods, prepends an ISO timestamp, and returns a cleanup function for tests. In the executable startup path, install timestamp wrappers first and file logging second so terminal output is timestamped while file serialization receives the original error arguments and retains one timestamp.

**Tech Stack:** Bun, TypeScript, `bun:test`, Node console APIs, existing `node:fs` logging code.

## Global Constraints

- Timestamp format MUST be generated with `new Date().toISOString()`.
- Scope is control-plane console output only; do not migrate worker logging or add a dependency.
- Existing additional arguments, structured objects, and `Error` details MUST remain observable.
- `control-plane-error.log` remains error-only and timestamped.
- Logging failures MUST NOT hide the original application error.
- Tests MUST restore exact prior console methods in `finally` blocks.

---

### Task 1: Specify timestamped console behavior in focused tests

**Files:**
- Modify: `apps/control-plane/src/index.test.ts:46-59`
- Test: `apps/control-plane/src/index.test.ts`

**Interfaces:**
- Consumes: the existing `configureErrorFileLogging(dataRoot: string): string` export and the new `configureTimestampedConsoleLogging(): () => void` export to be implemented in Task 2.
- Produces: deterministic contract tests for timestamp prefixes, argument preservation, warning coverage, error-file output, and cleanup.

- [ ] **Step 1: Add a test for timestamped `console.log` and `console.warn`**

Capture the original methods, replace them with collectors, install the timestamp wrapper, emit one log with a structured second argument and one warning, then assert the first argument matches `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /`, the second argument is unchanged, and both methods were called once. Restore all methods and invoke cleanup in `finally`.

```ts
const originalLog = console.log;
const originalWarn = console.warn;
const calls: unknown[][] = [];
console.log = (...args) => calls.push(args);
console.warn = (...args) => calls.push(args);
const restore = configureTimestampedConsoleLogging();
try {
  const details = { workerId: "worker-1" };
  console.log("worker connected", details);
  console.warn("retrying");
  expect(calls[0]?.[0]).toMatch(/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z worker connected$/);
  expect(calls[0]?.[1]).toBe(details);
  expect(calls[1]?.[0]).toMatch(/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z retrying$/);
} finally {
  restore();
  console.log = originalLog;
  console.warn = originalWarn;
}
```

- [ ] **Step 2: Extend the existing error-file test to assert its timestamp**

Keep the existing message and error-detail assertions, and add an assertion that the file content starts with an ISO timestamp followed by the serialized message. Do not require a fixed wall-clock value.

- [ ] **Step 3: Add cleanup coverage for the timestamp installer**

Use a captured method reference, install the wrapper, call the returned cleanup function, and assert `console.log` and `console.warn` are the same references captured before installation. Include `console.error` in the same assertion so all three methods are covered.

- [ ] **Step 4: Run the focused tests and verify failure before implementation**

Run:

```bash
bun test apps/control-plane/src/index.test.ts
```

Expected: the existing error-file test passes; new tests fail because `configureTimestampedConsoleLogging` is not yet exported.

- [ ] **Step 5: Commit the failing contract tests**

```bash
git add apps/control-plane/src/index.test.ts
git commit -m "test: define timestamped control-plane logs"
```

### Task 2: Implement timestamped console installation and startup wiring

**Files:**
- Modify: `apps/control-plane/src/index.ts:22-49,441-448`

**Interfaces:**
- Consumes: existing direct console calls and `configureErrorFileLogging(dataRoot: string): string`.
- Produces: exported `configureTimestampedConsoleLogging(): () => void`; the returned cleanup restores the exact console method references captured at installation time.

- [ ] **Step 1: Add a small timestamp wrapper helper**

Implement a local helper that accepts a console method and returns a function. Use `new Date().toISOString()` at invocation time and bind each original method before wrapping. Keep non-string values and all additional arguments unchanged:

```ts
const prefix = `[${new Date().toISOString()}]`;
if (typeof first === "string") original(`${prefix} ${first}`, ...remaining);
else if (args.length === 0) original(`${prefix} `);
else original(prefix, first, ...remaining);
```

This makes string messages render on one bracketed, timestamped line while structured first arguments remain structured values rather than being stringified. The zero-argument case still emits a bracketed timestamp with a trailing space.

- [ ] **Step 2: Implement `configureTimestampedConsoleLogging`**

Capture `console.log`, `console.warn`, and `console.error` references, replace each with timestamped wrappers, and return a cleanup function that restores those exact references. The cleanup must be safe to call once, and it must not swallow application exceptions because it performs only assignments.

- [ ] **Step 3: Preserve existing error-file behavior**

Do not change `configureErrorFileLogging`’s file path, error-only scope, serialized `Error` stack/message handling, or best-effort `appendFileSync` failure behavior. Its existing interceptor must continue to call its captured original error method once.

- [ ] **Step 4: Install wrappers in executable startup order**

At the `import.meta.main` block, call `configureTimestampedConsoleLogging()` first, then call `configureErrorFileLogging(...)`. This makes terminal errors timestamped while the file interceptor sees the original error arguments and writes exactly one ISO prefix. Ignore the returned cleanup in the long-running process.

- [ ] **Step 5: Run focused tests and verify the implementation**

Run:

```bash
bun test apps/control-plane/src/index.test.ts
```

Expected: all tests in the file pass, including timestamp shape, structured argument preservation, error-file persistence, and cleanup.

- [ ] **Step 6: Run the control-plane test suite**

Run:

```bash
bun test apps/control-plane/src
```

Expected: PASS with no cross-test console patch leakage.

- [ ] **Step 7: Commit the implementation**

```bash
git add apps/control-plane/src/index.ts apps/control-plane/src/index.test.ts
git commit -m "feat: timestamp control-plane console logs"
```

## Self-review checklist

- Spec coverage: console `log`, `warn`, and `error` are covered by Task 1 and implemented in Task 2; ISO formatting, argument preservation, file persistence, startup order, failure behavior, and cleanup are explicit.
- Placeholder scan: no `TBD`, `TODO`, vague future work, or undefined follow-up steps.
- Type consistency: `configureTimestampedConsoleLogging(): () => void` is introduced in Task 2 and consumed by Task 1; existing `configureErrorFileLogging(dataRoot: string): string` remains unchanged.
- Scope: one control-plane source file and its existing test file; no worker migration or dependency change.
