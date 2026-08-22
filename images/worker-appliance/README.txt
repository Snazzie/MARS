Whitesmith Ubuntu 24.04 x86_64 worker appliance

Build requirements: checksum-pinned Canonical Ubuntu 24.04 x86_64 qcow2, pinned GitHub Actions runner archive and checksum, compiled Linux job agent, virt-customize, qemu-img, cosign, and a signing key.
Runtime contract: one disposable libvirt VM per GitHub Actions lease, bootstrapped over diskless virtio-serial; no reusable guest identity or secret is stored in the image.
Release outputs: <name>.qcow2, <name>.qcow2.sha256, <name>.qcow2.sigstore.json, SBOM, provenance, and signed manifest.
