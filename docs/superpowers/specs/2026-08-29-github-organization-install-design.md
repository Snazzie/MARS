# GitHub Organization Installation Design

## Goal
Allow a signed-in Mars administrator to install the Mars GitHub App into any eligible GitHub organization, with GitHub—not a preselected Mars workspace—as the account picker.

## Current failure
The onboarding UI builds its account selector from locally synchronized OAuth organizations. The installation request stores that selected Mars workspace in setup state, then GitHub independently chooses an installation account. Selecting a different account produces `wrong_organization`; organizations absent from OAuth synchronization cannot be selected.

## Design
Add an unbound installation flow for the onboarding GitHub step. The control plane creates short-lived installation state containing the administrator and purpose but no required organization ID, then redirects to the standard GitHub App installation chooser. GitHub remains authoritative for the selected account.

When GitHub returns `installation_id`, the callback retrieves the installation account through the App API. It resolves the account by immutable GitHub account ID and account type. An existing matching Mars workspace is linked to the installation. If no matching organization workspace exists, the control plane creates the organization workspace, creates owner membership for the administrator, and persists the installation. Existing personal workspaces remain supported and are matched as `User` accounts. A previously explicitly bound installation continues to enforce the current mismatch protection.

The onboarding UI replaces the misleading account dropdown with an install button and explanatory copy. After the GitHub redirect, onboarding refreshes and displays the matched account. If GitHub refuses the installation or the account cannot be resolved, the existing error response remains visible and no setup state is consumed.

## Data flow
1. Admin opens onboarding GitHub step.
2. UI calls the onboarding install endpoint without `organizationId`.
3. Control plane saves short-lived `organization_install` state with `organizationId = null` and redirects to GitHub.
4. Admin selects `speedhq` or another eligible organization on GitHub.
5. GitHub redirects to `/api/github/app/setup?installation_id=...&setup_action=install`.
6. Callback fetches installation account, resolves/creates the matching Mars workspace, stores installation and repositories, consumes setup state, and redirects to onboarding.

## Safety and compatibility
- Match accounts by immutable numeric ID plus `User`/`Organization` type; never by login.
- Do not consume setup state until GitHub account validation and persistence can proceed.
- Preserve existing explicitly bound installation behavior and `wrong_organization` errors.
- Preserve repository-selection and post-install verification behavior.
- New workspace creation is limited to the authenticated global administrator who initiated the installation.
- No GitHub credentials or access tokens are exposed to the browser.

## Tests
- GitHub service tests cover unbound installation state, organization account resolution, new workspace creation, personal account matching, and state preservation on mismatch/failure.
- HTTP tests cover the install endpoint accepting an unbound request and callback redirecting after account resolution.
- Web tests cover rendering the install action and not requiring a locally synchronized organization dropdown.
- Existing bound-installation and repository-selection tests remain unchanged and passing.
