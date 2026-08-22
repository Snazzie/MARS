# Optional First-Run Setup Authorization

## Decision

The private deployment will not require the first-run setup code in the UI or setup API. The setup endpoint remains idempotency-key protected but accepts only the canonical public origin.

## Behavior

- Onboarding renders public-origin input only.
- `POST /api/setup/github-app` accepts `{ publicBaseUrl }` and `Idempotency-Key`.
- Backend configures the persisted origin without setup-code validation.
- Setup-code generation, logging, plaintext file lifecycle, and setup-code contract fields are removed.
- Existing setup, manifest, and deployment tests are updated to cover the code-free flow.

## Risk

Anyone able to reach the setup endpoint can configure the origin and initiate GitHub App creation. This is accepted because the control plane is privately deployed.
