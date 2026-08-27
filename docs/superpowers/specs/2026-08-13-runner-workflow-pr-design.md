# Mars Runner Workflow Pull Requests

## Goal

Let global administrators create a GitHub pull request that switches selected repository workflow jobs to the configured Mars runner labels. The action is available from onboarding and the dashboard repositories page.

## User flow

The repository action opens a modal. The modal:

- lists `.github/workflows/*.yml` and `.github/workflows/*.yaml` files that contain parseable jobs;
- defaults to all eligible workflow files;
- allows selecting individual workflow files;
- lists each selected job's current `runs-on` value;
- shows the proposed Mars label set beside each current value;
- refreshes its preview from the server when selection changes;
- keeps `Create PR` disabled until validation succeeds and the user explicitly confirms.

The server recomputes the preview during submission. Browser preview data is never trusted. A successful response provides the PR URL, branch, changed files, and replacement count.

## Architecture

Extend the existing GitHub App integration with an installation-token service for workflow discovery, repository content reads, refs, commits, and pull requests. Add repository-scoped control-plane API routes for workflow metadata/preview and PR creation. Reuse a single workflow-selection modal component from onboarding and the dashboard repositories page.

Runner labels come from the repository's configured pool and cannot be supplied by the browser. Existing organization/repository guards and global-admin authorization apply. The GitHub App requires repository contents write and pull-request write permissions.

## Mutation contract

The service resolves the repository default branch, validates selected paths against the discovered workflow list, and reads the current files from the branch head. It parses YAML and changes only `runs-on` values in workflow jobs. All other content remains unchanged. Scalar, array, and supported expression forms are handled explicitly; malformed YAML or unsupported `runs-on` shapes reject the operation with the file/job identified.

The service creates a unique `mars/use-runners-*` branch from the default branch, commits only changed workflow files, and opens a pull request with generated branch, commit, title, and body defaults. Users may edit the PR title and body. A stale branch head or changed workflow contents rejects submission and requires a refreshed preview. No-op selections create no branch or PR.

## Error handling

- Missing or unconfigured runner pool: actionable `422`.
- Invalid, unlisted, or traversal paths: validation error.
- Malformed YAML or unsupported job shape: identify the affected file/job and do not create a PR.
- Stale preview: reject with refresh-required response.
- GitHub permission/API failure: return a safe error without secrets.
- No matching `runs-on` jobs: explain that no PR is needed.

## Verification

Add focused tests for workflow discovery, selection filtering, YAML replacement for supported forms, authorization, stale-preview rejection, no-op behavior, GitHub API ordering, and both onboarding/dashboard entrypoints. Verify the modal lists current and proposed values before confirmation, and that the final request revalidates server-side. Run typecheck, focused tests, the full test suite, and a local browser smoke flow for both entrypoints.
