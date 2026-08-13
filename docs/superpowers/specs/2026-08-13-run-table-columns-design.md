# Run table identifier columns

## Goal

Make commit hash, branch, and run number independently scannable in the workflow-runs table.

## Design

Update `apps/web/src/components/RunTable.tsx` only:

- Keep the run-number detail link and workflow name together in a dedicated `Run #` column.
- Add a `Commit` column showing the first seven characters of `run.commitSha`.
- Preserve the full SHA in a `title` and accessible label so the abbreviated value remains inspectable.
- Add a `Branch` column showing `run.branch` without combining it with repository metadata.
- Keep `Repository` showing repository name and actor login.
- Preserve result, boundary, queued time, start delay, duration, loading behavior, and `allowDetails` behavior.

No contract or API changes are needed because `RunSummary` already supplies `runNumber`, `commitSha`, and `branch`.

## Verification

Render `RunTable` with representative run data and verify the markup contains separate headers and cells for Run #, Commit, and Branch, with the short SHA visible and the full SHA available as metadata. Run the focused web component test/build command used by the repository, then inspect the page in the browser for the updated table layout.
