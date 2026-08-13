# Task 1 Report: Workflow Discovery and Mutation

## Changed files
- `apps/control-plane/src/workflow-pr.ts`: Added typed workflow previews/selections/mutations, strict workflow path validation, YAML document parsing, job-level `runs-on` discovery, contextual validation errors, deterministic label-sequence mutation, and no-op handling.
- `apps/control-plane/src/workflow-pr.test.ts`: Added focused Bun tests for discovery, all/selected filtering, scalar/sequence/expression-compatible inputs, malformed/unsupported YAML, invalid paths, unlisted paths, and no-op selections.
- `apps/control-plane/package.json`: Added `yaml` dependency.
- `bun.lock`: Updated workspace/package resolution for `yaml`.

## Tests and output
- Initial red run: `bun test apps/control-plane/src/workflow-pr.test.ts` — failed before implementation (module absent), then exposed and fixed a test fixture syntax issue.
- Final focused test: `bun test apps/control-plane/src/workflow-pr.test.ts` — **4 pass, 0 fail, 11 expect() calls**.
- Package-local typecheck: `bun run --filter '@whitesmith/control-plane' typecheck` — **exited with code 0**.
- No formatter, linter, or project-wide test suite run.

## TDD evidence
Tests were written before implementation and executed in a failing state. The implementation was then added incrementally until the focused suite passed. The tests exercise observable API behavior and failure context rather than implementation details.

## Self-review
- YAML is parsed as a document and mutated structurally; unrelated keys and step content remain intact.
- Discovery accepts only `.github/workflows/<single-basename>.yml|yaml` paths and reports path/file/job context for invalid structures.
- `runs-on` scalar and string-sequence nodes are accepted; replacements are emitted as a deterministic YAML sequence.
- Selection defaults to all discovered files; explicit selections are validated against discovered paths.
- No selected jobs with `runs-on` produces a contextual no-op error; empty replacement labels are rejected.

## Concerns
- `applyWorkflowMutation` intentionally operates on one workflow document and uses a synthetic valid workflow path because its interface receives content only; caller-level file context belongs to discovery/preview/service layers.
- YAML serialization chooses block sequence style, which is valid YAML and deterministic but may reflow the targeted node's presentation.
