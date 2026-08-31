# Linux Control-Plane Image Design

## Goal

Publish a Linux/amd64 control-plane image for Unraid without shipping worker assets. The control plane obtains the current worker release from GitHub and uses contract-version compatibility to decide whether it can serve Linux worker enrollment.

## Architecture

The image contains the control-plane API, dashboard, database migrations, and production runtime only. It does not contain worker installers, orchestrator binaries, job agents, broker compose files, domain templates, VM images, or a worker release manifest.

At startup, the control plane fetches `worker-release-manifest.json` from the current GitHub release, validates it with the existing schema, and applies semantic contract compatibility. A release is compatible only when it has the same major version and a minor version less than or equal to the control plane's supported minor version; any patch version under that compatible major/minor boundary is accepted. A higher minor version or different major version is rejected. The control plane also requires a non-null `linux-x64` release for Linux worker enrollment. A failed fetch, invalid manifest, malformed contract version, incompatible release, or missing Linux release is an explicit deployment/runtime error; no fallback to packaged development data is allowed in production.

The validated manifest is cached for the process lifetime. Worker installer responses use URLs and hashes from the manifest. Large worker artifacts remain external HTTPS/OCI references and are downloaded by the worker installer/runtime, not by the control-plane image.

## Compatibility policy

Contract versions use `major.minor.patch` syntax. Given control-plane version `C` and worker-release version `W`, accept when `W.major === C.major` and `W.minor <= C.minor`; `W.patch` may be any non-negative value. Reject malformed versions, different majors, or higher worker minor versions. The control-plane supported version is configured independently from the release manifest and defaults to `0.1.0`.

## Build and release

The control-plane Dockerfile builds only Linux/amd64 runtime outputs and no longer requires Windows service-host artifacts or any worker release artifact copied into the build context. The release workflow publishes an immutable image, verifies required control-plane files, runs the existing smoke test, and promotes the verified digest to `ghcr.io/snazzie/mars/control-plane:latest`.

Worker release publication remains a separate concern. The control-plane release must not depend on Windows/macOS jobs or package their assets.
## Versioned action runs

Manual release runs expose a `patch`, `minor`, or `major` bump choice. The workflow finds the newest existing `vmajor.minor.patch` control-plane tag and applies the selected increment. If no matching tag exists, the baseline is `0.0.0`; therefore the first patch, minor, and major runs produce `0.0.1`, `0.1.0`, and `1.0.0` respectively. The calculated version becomes the image contract version and release tag. Existing tags are never overwritten.

## Configuration

Production configuration includes:

- `DATABASE_URL`
- `PUBLIC_BASE_URL`
- `GITHUB_WEBHOOK_URL`
- optional `WORKER_BASE_URL`
- worker release manifest URL, defaulting to the GitHub `releases/latest` asset endpoint
- supported worker contract version, defaulting to `0.1.0`

The Unraid XML template exposes the deployment inputs and optional release URL/version controls without embedding worker artifacts.

## Error handling

Manifest retrieval uses HTTPS and fails closed on network errors, non-success responses, invalid JSON, schema errors, contract-version mismatch, or missing Linux platform metadata. Errors identify the failed compatibility/release check and prevent serving a misleading enrollment command.

## Verification

Tests must cover:

- remote manifest URL/default and configurable source behavior;
- exact contract-version acceptance and rejection;
- missing Linux release rejection;
- worker asset URLs coming from the remote manifest;
- Linux-only image build inputs and absence of worker files;
- release workflow publication and digest promotion;
- Unraid template inputs and documentation.
