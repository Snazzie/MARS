# Worker v1 Release Design

## Scope

Release tag: `worker-v0.1.0`.

Supported v1 runtimes:

- Linux x64: container-only worker path; no KVM/libvirt, qcow2, or VM broker prerequisites.
- Windows x64: container-only worker path; no Windows VM runtime or Hyper-V VM installer path.
- macOS arm64: retain Tart because it is the supported macOS worker runtime.

## Integrity and artifact delivery

Remove cosign signing and verification for v1. Retain HTTPS-only downloads and SHA-256 validation for release artifacts.

Copied enrollment commands must contain:

- The immutable GitHub release asset URL for the selected platform and `worker-v0.1.0` tag.
- The selected control-plane URL.
- The one-use enrollment code.
- Windows container runtime arguments where applicable.

The worker downloads installer/runtime artifacts from GitHub. The control-plane URL is used for enrollment and worker communication, not installer distribution.

## Release assets

The release workflow builds and publishes Linux container, Windows container, and macOS Tart artifacts under `worker-v0.1.0`. The generated manifest records HTTPS URLs and SHA-256 values. VM-only fields and signature bundle fields are removed from the v1 contract.

## Acceptance

- UI-generated commands use GitHub tag assets and pass control-plane URL/code.
- Linux and Windows commands cannot select VM runtimes.
- macOS command uses the Tart-backed installer.
- All downloaded artifacts remain HTTPS and SHA-256 verified.
- Release workflow publishes the three v1 platform artifacts and manifest without cosign.
