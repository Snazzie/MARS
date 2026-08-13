# Run Detail Link Design

## Goal
Allow users to click a failed run in the Runs view and open its Whitesmith run-detail page.

## Design
The run-number cell remains the canonical navigation target. `RunTable` will render its existing `/runs/$runId` TanStack Router link for every run, including rows supplied by the cross-workspace (`all`) Runs page. The detail route will use the run's organization ID when loading the selected run, so cross-workspace navigation remains authorized and scoped correctly.

No external GitHub URL, database, or contract changes are required. A regression test will assert that a failed run renders a link containing its run ID.

## Verification
Run `bun test apps/web/src/components/RunTable.test.tsx` and inspect the resulting diff.
