Whitesmith Ubuntu 24.04 x86_64 worker appliance

Build requirements: checksum-verified Canonical image, pinned K3s/containerd 2, Kata Containers 4 runtime-rs, QEMU, CNI, cosign, Bun orchestrator.
Runtime contract: RuntimeClass whitesmith-kata -> io.containerd.kata.v2; no runc fallback.
Release outputs: qcow2, checksum, cosign bundle, SBOM, provenance, signed manifest.
