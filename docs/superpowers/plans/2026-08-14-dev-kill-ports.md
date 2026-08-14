# Opt-in Dev Port Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `bun dev --kill` clear stale listeners on development ports before startup.

**Architecture:** A focused port-cleanup module handles validation and Windows listener termination. A dev entrypoint parses flags, optionally cleans ports, builds Windows artifacts, and launches the existing concurrent processes.

**Tech Stack:** Bun, TypeScript, PowerShell on Windows.

## Global Constraints

- Cleanup is opt-in only.
- Only listeners on `PORT` and `WEB_PORT` may be terminated.
- Unknown options fail closed.
- Startup verifies cleaned ports are free.

---

### Task 1: Port cleanup helper

**Files:** Create `scripts/dev-ports.ts`; create `scripts/dev-ports.test.ts`.

- [ ] Add failing tests for argument parsing, port validation, duplicate normalization, and PowerShell cleanup behavior.
- [ ] Run the focused test and confirm failure.
- [ ] Implement `parseDevOptions`, `devPorts`, and `killDevPortListeners`.
- [ ] Run the focused test and confirm success.

### Task 2: Dev entrypoint

**Files:** Create `scripts/dev.ts`; modify `package.json`.

- [ ] Assert the package script delegates to `scripts/dev.ts`.
- [ ] Replace the shell script with a Bun entrypoint that optionally cleans listeners, builds worker artifacts, and launches concurrently.
- [ ] Run package and helper tests.

### Task 3: Verification and publication

- [ ] Start a disposable listener, invoke cleanup, and verify the process exits and port can be rebound.
- [ ] Run TypeScript checks and diff validation.
- [ ] Commit and push to `main`.
