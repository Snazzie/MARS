UPDATE runner_pools
SET driver = 'linux-libvirt-vm', enabled = false
WHERE driver = 'kata-k3s';
