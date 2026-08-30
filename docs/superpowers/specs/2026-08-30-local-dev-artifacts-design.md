# Local Development Worker Artifact Design

## Goal

Make local Windows worker development independent of GitHub release assets. A development installer must obtain every worker artifact from the local control plane or configured local files while retaining checksum verification.

## Behavior

When `NODE_ENV` is not `production`:

- The generated Windows installer uses the running control-plane origin for orchestrator and service-host downloads.
- The generated installer uses local control-plane endpoints or configured local paths for the Windows template and container dependencies.
- No GitHub `latest` release manifest or release asset URL is consulted.
- SHA-256 validation remains enabled for every downloaded artifact.

Production continues using immutable release metadata and release assets without behavior changes.

## Implementation

Add development-only artifact configuration to the control-plane environment and pass it through Windows installer generation. Add local artifact-serving routes where a configured local file is required. Keep generated installer values explicit so its fallback release URL cannot be selected in development.

The installer must fail clearly when a required local artifact is not configured or does not exist. It must not silently fall back to GitHub.

## Testing

Add focused tests covering:

- Development installer values point at local control-plane artifact routes or local artifact URLs.
- Development generation contains no GitHub release fallback values.
- Missing local artifacts produce an explicit unavailable response.
- Checksums remain injected and validated.
- Production installer generation remains release-backed.
