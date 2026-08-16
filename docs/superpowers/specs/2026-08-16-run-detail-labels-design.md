# Run Detail Labels

## Goal

Improve run-detail metadata readability by rendering runner IDs, requested labels, and top-level run context as compact design-system badges.

## Behavior

- The run header context renders repository, runtime boundary, branch, actor, and commit as individual badges.
- Each job header renders its runner ID as a badge, falling back to `Awaiting runner`, plus one badge per requested label.
- The metrics job header uses the same runner and requested-label badge treatment.
- Existing status badges, links, resource tables, and textual data remain unchanged.
- Badge content remains accessible as visible text; missing runtime boundary keeps its existing fallback.

## Implementation

Use `Badge` from `@astryxdesign/core/Badge` rather than introducing a local visual primitive. Add small local helpers in `RunDetailView.tsx` for repeated metadata and job badge rendering. Preserve current data contracts and avoid API changes.

## Verification

Extend existing `RunDetailView` tests to assert badge text and rendered badge markup for context, runner ID, requested labels, and fallback runner state. Run focused tests and the web typecheck.
