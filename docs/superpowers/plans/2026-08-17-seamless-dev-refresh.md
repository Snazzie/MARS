# Seamless Dev Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restart only the control-plane process when `.env` changes while retaining Bun source watching and the Vite process.

**Architecture:** Add a small control-plane dev supervisor that launches the existing Bun watcher and watches `.env`. On a debounced environment change it terminates and relaunches the child with `--env-file=.env`; source changes remain handled by Bun's watcher. Update the root launcher to use this supervisor instead of embedding the control-plane command in `concurrently`.

**Tech Stack:** Bun, TypeScript, Node-compatible `fs.watch`, concurrently.

## Global Constraints

- Keep the web/Vite process running during control-plane restarts.
- Do not change production server behavior or browser protocols.
- Preserve existing `--kill` port cleanup behavior.

---

### Task 1: Add control-plane development supervisor

**Files:**
- Create: `scripts/control-plane-dev.ts`

- [ ] Spawn `bun --watch run apps/control-plane/src/index.ts` with `--env-file=.env` and inherited stdio.
- [ ] Watch `.env` with a short debounce; terminate and relaunch only the child after changes.
- [ ] Forward termination signals and propagate a non-restart child exit code.
- [ ] Avoid restarting for duplicate filesystem events during one debounce window.

### Task 2: Wire root dev launcher

**Files:**
- Modify: `scripts/dev.ts:14-23`

- [ ] Replace the inline control-plane command with `bun run scripts/control-plane-dev.ts`.
- [ ] Leave the web command and concurrently process unchanged.

### Task 3: Verify refresh behavior

- [ ] Run the supervisor with PostgreSQL available.
- [ ] Confirm source changes still trigger Bun's watcher.
- [ ] Confirm `.env` changes restart the control-plane child while Vite remains running.
- [ ] Run targeted typecheck/build commands.
