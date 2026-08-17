# Windows Worker-Local Job Image Build

## Goal

Make Windows container workers self-sufficient. During install or reinstall, a worker downloads and verifies the Windows job-image inputs, builds the job image locally with the Windows Docker engine, proves the image, and caches provenance before registering the worker service. Jobs reuse that local image; they do not depend on a prebuilt registry image.

## Current Constraint

The control plane currently injects `DEFAULT_JOB_IMAGE_WINDOWS_X64` into the installer and the installer requires a digest-pinned image. That requires an external Windows image build and registry publication. The worker already has the required Windows Docker and Hyper-V capabilities, and the existing `Containerfile` plus image-build script define the image payload contract.

## Architecture

### Installer inputs

The control plane injects these trusted, immutable build inputs into the Windows installer:

- full `mcr.microsoft.com/windows/server:ltsc2025@sha256:<64-hex>` base reference;
- HTTPS Actions Runner archive URL and SHA-256;
- HTTPS Portable Git archive URL and SHA-256;
- HTTPS VC++ redistributable URL and SHA-256;
- local job-agent executable endpoint, downloaded from the control plane and hash-checked by HTTPS transport plus the existing artifact endpoint behavior.

The installer creates a restricted staging directory under `C:\ProgramData\Whitesmith\image-build`. URLs must be HTTPS; every downloaded file is verified against its injected SHA-256 before Docker receives it. The base image is pulled by its exact digest.

### Build and cache

`Ensure-WindowsContainerRuntime` performs the build before service replacement:

1. validate Docker Windows engine, Containers feature, and Hyper-V;
2. download or refresh the four external inputs and the job agent;
3. verify all hashes and exact base-image syntax;
4. build `whitesmith/windows-job:local` with the existing `Containerfile` and staged `verify-runtime.ps1`;
5. run the verifier in a Hyper-V container with `-RequireNetwork`;
6. require exit code zero, Media Foundation, DNS, and TCP/443 success;
7. inspect the image ID and write `C:\ProgramData\Whitesmith\windows-job-image.json` atomically;
8. remove the previous local image only after the new manifest is complete;
9. register the worker service with `WHITESMITH_WINDOWS_CONTAINER_IMAGE=whitesmith/windows-job:local` and local-image mode enabled.

The manifest contains the base digest, artifact hashes, image ID, verifier result, build timestamp, and schema version. A failed build leaves the existing service and cached image untouched. A first install fails closed without registering a worker service.

Reinstall repeats the build. A service restart does not rebuild.

### Runtime

The orchestrator continues to use `WindowsContainerDriver` with `--isolation=hyperv`. The local image is accepted only when its manifest exists, its image ID matches Docker inspection, and its runtime probe records all required booleans as true. No `--no-sandbox` or network-policy change is introduced.

### Control-plane configuration

The worker installer route adds configuration for the build inputs and emits a local image tag instead of requiring `DEFAULT_JOB_IMAGE_WINDOWS_X64`. Existing remote image configuration remains available only for non-local legacy installations and is not used by the new Windows container installer path.

## Failure handling

- invalid base reference, URL, or hash: fail before Docker build;
- download or hash failure: retain the prior image/service and report the artifact name;
- Docker build failure: include bounded Docker output and retain the prior image/service;
- verifier failure: include bounded probe logs and remove only the failed probe container;
- manifest write failure: do not replace the service environment;
- stale or missing manifest at worker startup: worker doctor reports not ready and the runtime rejects leases.

All temporary containers have Whitesmith ownership labels and are removed in `finally` blocks.

## Testing

- Add installer contract tests for build input placeholders, HTTPS-only URLs, local image tag, manifest path, atomic replacement, and failure-preserving behavior.
- Add image-build contract tests for local-only build mode, digest-pinned full Server base, staged verifier, and no registry push in worker mode.
- Add runtime contract tests for manifest/image-ID validation and stale-manifest rejection.
- Keep existing PowerShell parser checks and focused contract suite.
- On a Windows Docker worker, run the actual installer build, inspect the manifest, run the runtime verifier, and execute the Playwright page-creation smoke.

## Rollout

1. Deploy the control plane and worker installer code.
2. Drain the Windows pool.
3. Reinstall one Windows worker; verify local image manifest and runtime probe.
4. Dispatch the repository Windows Playwright smoke.
5. Reinstall remaining Windows workers and verify each manifest.
6. Enable the Windows pool and rerun RaceIQ job `95364529408`.
