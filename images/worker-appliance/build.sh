#!/usr/bin/env bash
set -euo pipefail

# Build a reproducible Ubuntu Noble worker appliance without requiring
# host virtualization on the hosted runner. Runtime proof remains host-side.
UBUNTU_QCOW2_URL="${UBUNTU_QCOW2_URL:-https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img}"
UBUNTU_SHA256SUMS_URL="${UBUNTU_SHA256SUMS_URL:-https://cloud-images.ubuntu.com/noble/current/SHA256SUMS}"
[[ "$UBUNTU_QCOW2_URL" == https://* && "$UBUNTU_SHA256SUMS_URL" == https://* ]] || { echo 'Ubuntu image and SHA256SUMS URLs must use HTTPS' >&2; exit 1; }
: "${RUNNER_ARCHIVE_URL:?set the pinned Actions Runner archive URL}"
: "${RUNNER_ARCHIVE_SHA256:?set the runner archive checksum}"
: "${JOB_AGENT_BINARY:?set the compiled Linux job-agent binary}"
[[ "$RUNNER_ARCHIVE_URL" == https://* ]] || { echo 'Actions Runner archive URL must use HTTPS' >&2; exit 1; }

command -v curl >/dev/null
command -v virt-customize >/dev/null
command -v qemu-img >/dev/null
command -v virt-resize >/dev/null
name=${1:-mars-worker}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl --fail --location --retry 3 --proto '=https' --tlsv1.2 "$UBUNTU_QCOW2_URL" --output "$work/base.qcow2"
curl --fail --location --retry 3 --proto '=https' --tlsv1.2 "$UBUNTU_SHA256SUMS_URL" --output "$work/SHA256SUMS"
base_name=${UBUNTU_QCOW2_URL##*/}
expected_base_sha256=$(awk -v name="$base_name" '$2 == name || $2 == "*" name { print $1; exit }' "$work/SHA256SUMS")
[[ "$expected_base_sha256" =~ ^[0-9a-f]{64}$ ]] || { echo "Ubuntu SHA256SUMS has no checksum for $base_name" >&2; exit 1; }
echo "$expected_base_sha256  $work/base.qcow2" | sha256sum --check --status
source_base_sha256=$(sha256sum "$work/base.qcow2" | cut -d' ' -f1)
printf '%s  %s\n' "$source_base_sha256" "$base_name" > "${work}/base.sha256"

curl --fail --location --retry 3 --proto '=https' --tlsv1.2 "$RUNNER_ARCHIVE_URL" --output "$work/runner.tar.gz"
echo "$RUNNER_ARCHIVE_SHA256  $work/runner.tar.gz" | sha256sum --check --status
cp "$JOB_AGENT_BINARY" "$work/mars-job-agent"
test -s "$work/mars-job-agent"
# The Noble cloud image's root filesystem is too small for the offline
# Actions Runner expansion. Grow the virtual disk and root partition before
# adding the runner and job agent.
qemu-img resize "$work/base.qcow2" +4G
expanded_size=$(qemu-img info --output=json "$work/base.qcow2" | jq -r '."virtual-size"')
qemu-img create -f qcow2 "$work/expanded.qcow2" "$expanded_size"
virt-resize --expand /dev/sda1 "$work/base.qcow2" "$work/expanded.qcow2"
mv "$work/expanded.qcow2" "$work/base.qcow2"

virt-customize -a "$work/base.qcow2" \
  --install ca-certificates,curl,tar \
  --mkdir /opt/actions-runner \
  --copy-in "$work/runner.tar.gz:/opt/actions-runner" \
  --copy-in "$work/mars-job-agent:/usr/local/bin" \
  --run-command 'tar -xzf /opt/actions-runner/runner.tar.gz -C /opt/actions-runner && rm -f /opt/actions-runner/runner.tar.gz' \
  --run-command 'install -d -m 0755 /var/lib/mars && useradd --system --create-home mars || true' \
  --run-command 'chown -R mars:mars /opt/actions-runner /usr/local/bin/mars-job-agent /var/lib/mars' \
  --run-command 'rm -rf /var/lib/cloud/instances/* /etc/ssh/ssh_host_* /var/log/*.log /var/cache/apt/*' \
  --run-command 'truncate -s 0 /etc/machine-id' \
  --run-command 'systemctl disable ssh || true'

qemu-img check "$work/base.qcow2"
mkdir -p dist
cp "$work/base.qcow2" "dist/$name.qcow2"
base_sha256="$source_base_sha256"
output_sha256=$(sha256sum "dist/$name.qcow2" | cut -d' ' -f1)
printf '%s  %s\n' "$base_sha256" "$base_name" > "dist/$name.base.sha256"
printf '%s  %s\n' "$output_sha256" "dist/$name.qcow2" | tee "dist/$name.qcow2.sha256"
qemu-img info --output=json "dist/$name.qcow2" > "dist/$name.qcow2.qemu.json"
printf '{"baseImage":"%s","baseSha256":"%s","output":"%s","outputSha256":"%s"}\n' "$base_name" "$base_sha256" "$name.qcow2" "$output_sha256" > "dist/$name.appliance.json"
