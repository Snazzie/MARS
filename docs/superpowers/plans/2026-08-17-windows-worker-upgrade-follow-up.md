# Windows Worker Upgrade Follow-up Plan

Do not implement automatic worker upgrades from the dashboard yet. The current deliverable is a worker-card button that generates a manually runnable Windows upgrade command. A future button may dispatch the same operation through an authenticated durable worker command; it must not introduce a second upgrade implementation.

The generated command downloads `/api/workers/installer?audience=windows-x64&runtime=...` and invokes it with `-Upgrade`.

## Immediate command contract

Add a dedicated generated PowerShell command/script for an existing Windows worker:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\upgrade-worker.ps1
```

The command MUST:

1. Require an elevated PowerShell session.
2. Require the existing `WhitesmithWorker` service and `C:\ProgramData\Whitesmith\worker-identity.json`.
3. Require the operator to drain the worker and wait for zero active leases before execution.
4. Download the current Windows worker installer and build inputs from the control plane.
5. Rebuild and verify the configured local Windows job image before replacing the service.
6. Stage and hash-verify the orchestrator, service-host, and image artifacts.
7. Replace the existing service binaries/environment without deleting `worker-identity.json` or changing the worker ID/keypair.
8. Restart the service and wait for it to reconnect.
9. Fail before service replacement on download, hash, image, or runtime-probe errors.
10. Print the preserved worker ID, old/new release IDs, image ID, and reconnect result.

The command must support both Hyper-V container and VM runtime modes. It must never call `/api/workers/join`, consume a bootstrap code, or create a pending worker.

## Files for the manual command

- Create `deploy/workers/upgrade-worker.ps1` as the operator-facing upgrade entrypoint.
- Modify `deploy/workers/install-worker.ps1` only to expose a shared identity-preserving upgrade mode; normal enrollment behavior remains unchanged.
- Modify the control-plane installer artifact route only if the upgrade command requires a distinct generated artifact set. Prefer existing public, hash-verified artifact routes.
- Add PowerShell parser and installer contract tests covering identity preservation, drain/active-lease preconditions, staging, rollback-before-replacement, and no join-code path.
- Add a generated-command contract test to ensure the documented command is the one operators receive.

## Future dashboard button

When resumed, add a worker-card Upgrade action that dispatches the manual command through the existing authenticated worker command channel:

1. API requires adopted Windows worker, `draining=true`, and zero active leases.
2. API creates one durable `worker.upgrade` command; duplicate pending requests are rejected/idempotent.
3. Worker acknowledges, launches the same staged upgrade entrypoint, and restarts.
4. Control plane waits for the same worker ID and post-upgrade doctor/image evidence.
5. Worker remains drained until successful evidence is observed.
6. Failure leaves it drained and exposes remediation/retry; no new enrollment is created.

Future command payload must contain release/artifact references and SHA-256 digests only. Never include join codes, private keys, or other secret material.

## Explicitly deferred

- Dashboard Upgrade button.
- `worker.upgrade` shared command schema and durable command state.
- Automatic drain from the button.
- Cross-platform (Linux/macOS) upgrades.
- Production rollout and live smoke validation.

## Resume checklist

- [ ] Implement `deploy/workers/upgrade-worker.ps1`.
- [ ] Add failing PowerShell and generated-command tests.
- [ ] Add installer `-Upgrade` identity-preservation mode.
- [ ] Run parser and focused contract tests red/green.
- [ ] Execute elevated disposable-worker smoke test.
- [ ] Then resume the dashboard/durable-command design in `docs/superpowers/specs/2026-08-17-windows-worker-upgrade-design.md`.
