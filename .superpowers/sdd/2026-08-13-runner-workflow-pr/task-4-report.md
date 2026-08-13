
## Modal tests
- Added `RunnerWorkflowPrModal.test.tsx` covering runs-on formatting, disabled states for invalid/no-op/loading/success, expected head SHA contract, and server-only labels.
- Verification: modal + onboarding focused tests pass 15 total / 59 assertions; web typecheck passes.
- Full DOM interaction coverage remains constrained by no testing-library/jsdom dependency in the web package.
