# Linux Control-Plane Image Design

## Goal

Publish a Linux/amd64 control-plane image for Unraid without shipping worker assets. The control plane obtains the current worker release from GitHub and uses contract-version compatibility to decide whether it can serve Linux worker enrollment.

## Architecture

The image contains the control-plane API, dashboard, database migrations, and production runtime only. It does not contain worker installers, orchestrator binaries, job agents, broker compose files, domain templates, VM images, or a worker release manifest.

At startup, the control plane fetches `worker-release-manifest.json` from the current GitHub release, validates it with the existing schema, and requires an exact match between the manifest `contractVersion` and the control plane's supported worker contract version (`0.1.0` initially). It also requires a non-null `linux-x64` release for Linux worker enrollment. A failed fetch, invalid manifest, contract mismatch, or missing Linux release is an explicit deployment/runtime error; no fallback to packaged development data is allowed in production.

The validated manifest is cached for the process lifetime. Worker installer responses use URLs and hashes from the manifest. Large worker artifacts remain external HTTPS/OCI references and are downloaded by the worker installer/runtime, not by the control-plane image.

## Build and release

The control-plane Dockerfile builds only Linux/amd64 runtime outputs and no longer requires Windows service-host artifacts or any worker release artifact copied into the build context. The release workflow publishes an immutable image, verifies required control-plane files, runs the existing smoke test, and promotes the verified digest to `ghcr.io/snazzie/mars/control-plane:latest`.

Worker release publication remains a separate concern. The control-plane release must not depend on Windows/macOS jobs or package their assets.

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
