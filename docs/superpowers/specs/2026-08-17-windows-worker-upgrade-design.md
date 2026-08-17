# Windows Worker Upgrade Design

## Goal

Add a worker-card upgrade action for Windows x64 workers. Upgrade must modify the existing worker in place, preserve its control-plane identity, and never register a replacement worker.

## Preconditions

The control-plane upgrade endpoint MUST require:

- an adopted Windows x64 worker;
- the worker is draining;
- zero active leases;
- no pending upgrade for that worker.

The endpoint MUST reject upgrades that do not satisfy these conditions. The API, not only the UI, enforces these rules.

The UI exposes Upgrade only when the worker is adopted, draining, and has no active leases. The existing Drain action remains separate; upgrade does not automatically drain or terminate jobs.

## Control-plane flow

1. An authorized administrator selects Upgrade on the worker card.
2. The control plane validates the preconditions in a transaction.
3. It creates one durable `worker.upgrade` command for the worker.
4. The command contains a release identifier and non-secret, hash-verified artifact/build inputs required by the Windows installer. It MUST NOT contain join codes, private keys, or other secret material.
5. The worker remains drained and ineligible for scheduling until it reconnects and reports successful post-upgrade health.
6. The control plane exposes pending, acknowledged, failed, and completed state through the existing worker detail/status model or the command result associated with the worker.

Repeated requests MUST be idempotent while an upgrade is pending. A second upgrade MUST NOT enqueue a second command.

## Worker flow

1. The Windows worker receives `worker.upgrade` through the authenticated command channel.
2. It acknowledges command acceptance before beginning the local transition.
3. It downloads the versioned installer/build inputs from the control plane.
4. The installer verifies every configured artifact hash and rebuilds/verifies the local Windows job image.
5. The installer replaces the orchestrator/service-host binaries and service environment.
6. The installer MUST preserve `C:\ProgramData\Whitesmith\worker-identity.json` and the existing worker ID/keypair.
7. The service restarts using the existing identity.
8. The worker reconnects, reports doctor/capacity data, and retains the same control-plane worker ID.
9. The control plane marks the upgrade complete only after the expected release/runtime evidence is observed.

The worker command handler MUST not create a pending enrollment or call the join endpoint during an upgrade.

## Failure and recovery

- Artifact download, hash, image build, runtime probe, or service replacement failure MUST leave the previous worker executable/service usable whenever the failing step permits rollback.
- A failed upgrade leaves the worker drained and records actionable remediation.
- The durable command MUST remain replayable after a worker reconnect unless it reached a terminal success state.
- Upgrade retry MUST be explicit and MUST NOT create another worker identity.
- If replacement cannot be made atomic on Windows, the installer MUST stage new files first and only replace the live service after all verification steps pass.

## Command contract

Add `worker.upgrade` to the shared worker command schema. Its payload MUST be versioned and parseable, containing:

- release/build identifier;
- Windows runtime mode (`container` or `vm`);
- artifact URLs or configured artifact references;
- SHA-256 digests for every downloaded artifact;
- expected post-upgrade runtime/image evidence.

The command event sequence MUST include command acceptance and a terminal success/failure event tied to the command ID. Existing command persistence and replay semantics remain authoritative.

## UI

Add an Upgrade action to the existing Windows worker card/action component. The confirmation dialog MUST state that the worker must be drained and have no active jobs. The action is disabled or absent until the server-reported preconditions hold. On success, invalidate worker queries and show that the worker remains drained while upgrading.

The UI MUST NOT present upgrade as enrollment and MUST NOT generate a bootstrap code for this operation.

## Verification

Add contract tests for:

- API rejection when the worker is not drained;
- API rejection when active leases remain;
- idempotent pending upgrade creation;
- command payload secret exclusion and schema validation;
- worker identity preservation and no join call during upgrade;
- durable replay and terminal failure handling;
- worker-card visibility/confirmation behavior.

Run focused control-plane, orchestrator, and web tests plus the Windows PowerShell parser checks. A live Windows upgrade smoke test must drain a disposable worker, issue the card/API action, verify the same worker ID reconnects, and verify no additional pending worker appears.
