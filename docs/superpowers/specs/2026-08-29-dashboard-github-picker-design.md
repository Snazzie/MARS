# Dashboard GitHub Picker Design

## Goal

After onboarding, administrators can connect any GitHub account or organization from `/repositories`, then manage, uninstall, and reinstall the Mars GitHub App.

## UX

The dashboard keeps the workspace selector but the primary connect action launches GitHub's account picker directly. GitHub chooses the target account; Mars resolves it by immutable account ID and account type. On callback, Mars imports the installation repositories and returns to `/repositories`.

For an existing selected workspace, the GitHub connection disclosure exposes sync and uninstall. Uninstall removes the installation's access and makes repositories unavailable. The connect action remains available for reinstalling the app.

## Data Flow

`RepositoriesPage` calls the unbound onboarding-install endpoint for connection. The endpoint creates an unbound setup state, redirects to the configured GitHub App installation URL, and sets the existing HttpOnly installation-state cookie. The callback validates the GitHub installation account, resolves or creates the workspace, persists installation/repositories, consumes state, clears the cookie, and redirects to the dashboard repository page.

## Error Handling

Known setup failures remain JSON errors and preserve the state cookie except explicit repository-selection remediation. Query/mutation errors render in the existing dashboard alert. Uninstall uses the existing confirmation dialog and invalidates organization/repository queries on success.

## Testing

Add dashboard tests proving the connect action invokes the unbound endpoint and redirects, and that uninstall/reinstall controls remain available. Preserve existing bound settings and repository sync tests. Run focused control-plane and web tests plus web typecheck; report unrelated pre-existing control-plane type errors.
