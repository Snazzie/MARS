# `/runs` Runner Filter

## Goal

Let operators filter run history by runner ownership while preserving the current unfiltered view.

## Behavior

`/runs` displays a three-option segmented toggle:

- **All** — show Whitesmith and external runs. This is the default.
- **Whitesmith** — show runs whose `allocationState` is `whitesmith`.
- **External** — show runs whose `allocationState` is `external`.

The runner filter composes with the existing search and queued-time range filters. Empty results use the existing run-history empty state. The toggle exposes the selected option with `aria-pressed`.

## Implementation

Keep filtering client-side in `RunHistory`, extending its pure filtering function with a runner-filter argument. `RunsPage` remains responsible only for loading data; no API or database changes are required.

Use the existing run-history toolbar and button styling. Add focused unit coverage for all three predicate modes and rendered toggle state.

## Verification

Run the focused `RunHistory` and `/runs` tests. Review the final diff for unchanged default behavior and correct external-run classification.
