#!/usr/bin/env bash
set -euo pipefail
: "${UBUNTU_QCOW2_URL:?set checksum-pinned Ubuntu 24.04 qcow2 URL}"
: "${UBUNTU_QCOW2_SHA256:?set Ubuntu qcow2 checksum}"
: "${RUNNER_ARCHIVE_URL:?set checksum-pinned GitHub Actions runner archive URL}"
: "${RUNNER_ARCHIVE_SHA256:?set runner archive checksum}"
: "${JOB_AGENT_BINARY:?set compiled Linux job agent}"
: "${COSIGN_KEY:?set cosign signing key}"
command -v virt-customize >/dev/null
command -v qemu-img >/dev/null
command -v cosign >/dev/null
name=${1:-whitesmith-worker}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl --fail --location --output "$work/base.qcow2" "$UBUNTU_QCOW2_URL"
echo "$UBUNTU_QCOW2_SHA256  $work/base.qcow2" | sha256sum --check --status
curl --fail --location --output "$work/runner.tgz" "$RUNNER_ARCHIVE_URL"
echo "$RUNNER_ARCHIVE_SHA256  $work/runner.tgz" | sha256sum --check --status
cp "$JOB_AGENT_BINARY" "$work/whitesmith-job-agent"
virt-customize -a "$work/base.qcow2" --install ca-certificates,curl --mkdir /opt/actions-runner --copy-in "$work/runner.tgz:/opt/actions-runner" --copy-in "$work/whitesmith-job-agent:/usr/local/bin" --run-command 'useradd --system --create-home whitesmith || true' --run-command 'rm -rf /var/lib/cloud/instances/* /etc/ssh/ssh_host_* /var/log/*.log /var/cache/apt/*' --run-command 'truncate -s 0 /etc/machine-id' --run-command 'systemctl disable ssh || true'
qemu-img check "$work/base.qcow2"
mkdir -p dist
cp "$work/base.qcow2" "dist/$name.qcow2"
sha256sum "dist/$name.qcow2" | tee "dist/$name.qcow2.sha256"
cosign attest --predicate <(printf '{"artifact":"%s"}\n' "$name") --key "$COSIGN_KEY" "dist/$name.qcow2"
qemu-img info --output=json "dist/$name.qcow2" > "dist/$name.qcow2.qemu.json"
