# Local Worker Installer URL Design

## Goal

During local development, worker enrollment and Windows worker upgrades must download installer scripts from the running Mars control plane instead of GitHub releases. Production keeps the immutable GitHub release asset URLs.

## Scope

Update the web command builders used by initial worker enrollment and Windows worker upgrades. The control-plane installer endpoint already exists and generates platform-specific installers from local packaged artifacts.

## Behavior

Development commands use the control-plane endpoint:

`<control-plane-origin>/api/workers/installer?audience=<platform>&runtime=container&connectOrigin=<selected-origin>`

The selected `connectOrigin` remains the origin embedded in the generated installer. The URL must be encoded with `URLSearchParams` or equivalent URL-safe encoding.

Production commands continue using the existing GitHub release asset URL. Environment detection follows the existing web application convention; no new deployment setting is introduced.

Both initial enrollment and Windows upgrade commands use the same environment-aware URL policy. Shell quoting, HTTP opt-in behavior, cleanup, and download failure handling remain unchanged.

## Testing

Add focused tests for both command builders:

- Development mode emits the local `/api/workers/installer` endpoint and does not emit the GitHub installer URL.
- Production mode emits the immutable GitHub release asset URL.
- Platform and runtime query parameters are correct.
- Existing command safety and control-plane-origin assertions remain covered.

No installer implementation or release packaging changes are required.
