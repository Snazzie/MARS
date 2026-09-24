# MARS

<img src="assets/mars-icon.svg" alt="MARS logo" width="320">

**MARS (Managed Action Runner System)** brings scattered Windows, macOS, and Linux hardware together as your own GitHub Actions runner cluster. Manage workers centrally while choosing the platform and compute resources each workflow needs.

## Features

- **Pool the hardware you already have:** Bring workers on different hosts into a centrally managed runner fleet.
- **Run multiple jobs per worker:** Allocate a worker's capacity across concurrent jobs instead of dedicating a whole machine to each job.
- **Share workers across organizations:** Use one worker fleet for repositories in multiple GitHub organizations.
- **Request the compute you need:** Specify CPU and memory in resource-aware `runs-on` labels, and route jobs to compatible pools. [Routing guide](docs/worker-routing-labels.md).
- **Keep downloads local:** A worker-local caching proxy reduces repeated downloads of GitHub Actions resources.
- **Choose the execution environment:** Route across Windows x64, macOS ARM64, and Linux x64 pools; Windows supports Hyper-V-isolated containers or checkpoint-based VMs, and macOS uses Tart images. [Windows runtime options](docs/windows-worker-runtimes.md).
- **Manage the fleet from one place:** Onboard and approve workers, inspect health, and connect repositories through the control plane and dashboard.

> **Development status:** MARS is not yet a production-ready runner platform. Control-plane hosting is the current Linux/amd64 deployment milestone; end-to-end GitHub Actions job execution remains unfinished. See [implementation status](IMPLEMENTATION-STATUS.md) for the precise scope and blockers.

## Get started

- [Development setup and worker commands](docs/development.md)
- [Windows worker runtimes and prerequisites](docs/windows-worker-runtimes.md)
- [Control-plane deployment guide](deploy/control-plane/README.md)
- [Implementation status](IMPLEMENTATION-STATUS.md)

## License

No license has been declared yet.
