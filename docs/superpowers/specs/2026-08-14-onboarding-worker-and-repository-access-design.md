# Onboarding Worker and Repository Access Design

## Problem

The onboarding flow currently advances from Worker as soon as a pending worker is selected, then asks the administrator to approve and configure it in a separate Resources step. This splits one decision across two steps and permits the UI to present GitHub setup before worker approval is complete.

Repository access has a second, redundant authorization layer. GitHub App installation access determines which repositories Mars can reach, but Mars also stores an `approved` flag and requires the administrator to select repositories during onboarding. The two sources of truth can drift. The onboarding checkboxes and the Windows guest-platform checkbox also inherit text-input sizing, producing oversized controls.

## Goals

- Combine worker selection, approval, capacity limits, guest-platform selection, and configuration acknowledgement into one mandatory Worker step.
- Remove the separate Resources step.
- Make the GitHub App installation the sole repository authorization boundary.
- Automatically use every repository currently available to the installation, including public repositories.
- Preserve repository records and historical runs after GitHub access is revoked or a repository disappears.
- Handle repository-specific GitHub 404 responses as a graceful availability transition.
- Render remaining checkboxes at compact native-control dimensions without changing text or numeric input sizing.

## Non-goals

- Changing organization membership or control-plane administrator authorization.
- Changing worker capacity validation or the worker configuration protocol.
- Deleting historical repository, run, or discovery data when GitHub access changes.
- Treating GitHub authentication failures, rate limits, or server errors as proof that a repository disappeared.
- Renaming the GitHub installation lifecycle state `approved`; it describes an active verified installation, not operator approval of individual repositories.

## Onboarding Flow

`OnboardingStep` becomes:

1. `admin`
2. `worker`
3. `github`
4. `labels`
5. `complete`

The `resources` value is removed from the contract and every caller.

### Worker gate

With an administrator present, the server reports `worker` when any of these conditions holds:

- no selectable worker has been recorded;
- the selected worker is not `adopted`;
- the selected worker configuration is not `ready`.

The Worker UI has two sequential states:

1. No selected worker: render enrollment, pending-worker status, and explicit worker selection.
2. Selected worker not ready: render `WorkerConfigurationForm` for that worker in the same step. The form performs admission approval and capacity configuration together. After submission, poll the server and remain on Worker until the worker acknowledges a ready configuration.

A selected, adopted, ready worker advances to GitHub. The UI cannot advance independently of the server state.

### GitHub gate

The GitHub step connects, installs, or repairs the GitHub App. It contains no repository picker and no repository approval submission.

The server reports GitHub as ready when the selected organization has:

- an active installation whose state is `approved`;
- an installation repository selection of `all` or `selected`; and
- at least one repository with `available=true`.

Visibility does not affect readiness. Public, private, and internal repositories exposed by the installation are all usable.

When GitHub exposes no repositories, installation completion remains pending and the existing repository-selection remediation sends the administrator back to GitHub. Once the installation exposes at least one repository, onboarding advances automatically to Trigger labels.

## Repository Authorization Model

Remove Mars's per-repository `approved` state completely. A repository is authorized when:

- its GitHub App installation is active; and
- its repository row has `available=true`.

This predicate is used consistently by job discovery, workflow configuration, runner workflow pull-request creation, dashboard actions, onboarding readiness, and repository lookup helpers.

The clean cutover removes:

- `RepositorySummary.approved`;
- `ApproveOnboardingRepositoriesRequest`;
- the onboarding repository-approval route and web client function;
- organization repository approve/reject routes and web client functions;
- repository approval controls and status columns in the Repositories page;
- `dashboard_repositories.approved` and every query, insert, update, and predicate that references it.

The database schema omits `approved` for new installations and drops it with `DROP COLUMN IF EXISTS` for existing databases after application queries have been migrated.

## Synchronization and Availability

GitHub is authoritative for availability.

- Installation completion inserts every returned repository with `available=true`, regardless of visibility.
- Repository-added events and full installation snapshots insert or update the existing GitHub repository row with `available=true`.
- Repository-removed events set the matching row to `available=false`.
- A full snapshot sets rows absent from the snapshot to `available=false`.
- Installation suspension, deletion, or uninstall sets all of its repository rows to `available=false`.
- Re-adding access updates the existing row to `available=true`; it does not create disconnected history.

Repository rows are never deleted solely because GitHub access changed. Run history, discovery checkpoints, and repository identity remain intact.

## Missing Repository Error Handling

A repository-specific GitHub API response of 404 means the installation no longer has access or the repository no longer exists. The operation that observes the 404:

1. atomically sets that repository row to `available=false`;
2. stops new discovery or workflow setup for it;
3. returns a stable `github_repository_unavailable` domain error where an interactive caller needs a response; and
4. preserves historical data.

A discovery pass records that repository as skipped and continues processing other repositories rather than failing the entire pass.

Responses for invalid installation credentials, 403, 429, and GitHub 5xx failures remain operational errors. They do not mutate repository availability because they do not prove repository-specific access was removed.

## Repository UI

The Repositories page keeps the existing Available and Unavailable views.

Available repositories can create or update Mars runner workflows without an additional approval action. Unavailable repositories:

- remain visible in the Unavailable view;
- show that GitHub no longer grants access;
- retain links to historical runs and metadata; and
- disable new runner-workflow actions.

The Approved/Not approved status column and Approve/Remove action are removed.

## Checkbox Styling

The remaining worker guest-platform checkbox uses a checkbox-specific style rather than the broad onboarding and worker input rules:

- compact fixed inline/block dimensions;
- no text-input padding or minimum height;
- visible focus outline;
- theme accent color;
- label remains a normal clickable target.

Text, number, and select inputs retain their existing dimensions. Repository checkboxes disappear with the repository picker. The guest-platform checkbox moves with the configuration form from Resources into Worker and uses the compact style there.

## Error and Recovery UX

- Worker configuration validation errors remain inline in the Worker step.
- Configuration submission failure leaves the selected worker and entered limits visible for retry.
- Configuration acknowledgement delay shows a waiting status and keeps Worker current.
- A missing/revoked repository changes to Unavailable without deleting history.
- GitHub App reconnection or repository re-selection can restore the same row automatically.
- GitHub installation with zero repositories retains the existing repository-selection remediation path.

## Verification

### Contracts and persistence

- Contract tests reject `resources` as an onboarding step and no longer expose repository approval schemas or fields.
- Database tests prove a pending or unconfigured selected worker remains on Worker.
- Database tests prove only an adopted, ready worker advances to GitHub.
- GitHub readiness requires an active installation and at least one available repository, without an approval predicate.
- Schema migration tests confirm the approval column is absent after migration.

### GitHub behavior

- Installation completion makes public, private, and internal repositories available automatically.
- Added, removed, snapshot, suspension, uninstall, and re-addition events transition availability while retaining repository identity.
- Repository-specific 404 marks only that repository unavailable.
- 403, 429, and 5xx responses do not change availability.
- Discovery continues past a repository that becomes unavailable.

### Web behavior

- Onboarding renders Admin, Worker, GitHub, and Trigger labels only.
- Worker selection reveals approval and configuration in Worker.
- The UI remains on Worker until server state is adopted and ready.
- GitHub has no repository picker or repository approval button.
- Repositories has no approval status or approval actions; unavailable workflow actions are disabled.

### Runtime verification

Browser-drive the actual onboarding surface at desktop and mobile widths. Confirm:

- four-step progress;
- inline worker approval and configuration;
- compact guest-platform checkbox sizing and keyboard focus;
- no Resources step;
- no repository picker;
- automatic transition from an installation with available repositories; and
- graceful Unavailable repository display after revoked access.
