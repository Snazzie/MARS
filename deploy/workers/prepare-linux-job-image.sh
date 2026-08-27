#!/usr/bin/env bash
set -euo pipefail
job_agent=''; runner_root='/opt/actions-runner'
while (($#)); do case "$1" in --job-agent) job_agent="$2"; shift 2;; --runner-root) runner_root="$2"; shift 2;; *) echo "unknown argument: $1" >&2; exit 2;; esac; done
[[ -n "$job_agent" && -x "$runner_root/run.sh" ]] || { echo 'job agent and executable runner root are required' >&2; exit 1; }
install -D -m 0755 "$job_agent" /usr/local/bin/mars-job-agent
install -d -m 0700 /var/lib/mars
cat >/etc/systemd/system/mars-guest.service <<EOF
[Unit]
Description=Mars guest job service
After=dev-virtio\\x2dports-org.mars.bootstrap.device network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/bin/mars-job-agent guest-service --platform linux-x64 --runner-root $runner_root
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$runner_root
NoNewPrivileges=true
Restart=no
ExecStopPost=/usr/bin/systemctl poweroff
EOF
systemctl enable mars-guest.service
sha256sum /usr/local/bin/mars-job-agent
