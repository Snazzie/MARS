# Worker v1 Release Design

## Scope

Release tag: `worker-v0.1.0`.

Preserve the existing Linux and Windows worker runtime architecture, including their current VM/container capabilities. No runtime conversion is required for v1. Preserve macOS arm64 Tart support.

## Installer delivery

The control plane generates one copied command per platform. The command downloads the platform installer script from the immutable GitHub release asset for `worker-v0.1.0`, then runs that script with:

- the selected control-plane URL;
- the one-use enrollment code;
- the existing platform/runtime arguments where applicable.

The installer script contains the complete prerequisite, artifact, service, enrollment, and authenticated-worker flow. Runtime binaries and support artifacts are downloaded from GitHub release assets or the existing immutable artifact references; the control-plane URL is used for enrollment and worker communication.

## Integrity

Cosign signing is not required for v1. Retain HTTPS-only downloads and SHA-256 verification where already supported. Do not add fake signatures or claim signed releases.

## Release assets

Publish self-contained Linux, Windows, and macOS installer scripts under stable names:

- `install-worker-linux-x64.sh`
- `install-worker-windows-x64.ps1`
- `install-worker-macos-arm64.sh`

Preserve existing VM/container release metadata and runtime paths unless needed solely to make the copied GitHub installer self-contained.

## Acceptance

- Copied commands resolve to the `worker-v0.1.0` GitHub release assets.
- Commands include the control-plane URL and enrollment code.
- Each downloaded installer contains its complete existing install flow and accepts those arguments.
- Linux and Windows runtime capabilities remain unchanged.
- macOS Tart remains supported.
- Release assets are observable before claiming publication.
