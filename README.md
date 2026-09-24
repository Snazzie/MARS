# MARS

<img src="assets/mars-icon.svg" alt="MARS logo" width="320">

**MARS (Managed Action Runner System)** is a self-hosted platform for managing GitHub Actions workers across Windows, macOS, and Linux. A central control plane connects GitHub, the dashboard, and worker hosts so teams can configure where workflows run.

## Features

- **One place to manage workers:** Onboard hosts, organize worker pools, inspect health and capacity, and approve new workers from the dashboard.
- **Cross-platform routing:** Configure resource-aware `runs-on` labels for Windows x64, macOS ARM64, and Linux x64 pools, with CPU and memory requests per workflow. [Routing guide](docs/worker-routing-labels.md).
- **Isolated job environments:** Windows workers offer Hyper-V-isolated containers or checkpoint-based Hyper-V VMs; macOS workers use Tart images. [Windows runtime options](docs/windows-worker-runtimes.md).
- **GitHub integration:** Connect a GitHub App, receive signed webhooks, and manage runs and worker connections through the control plane.
- **Self-hosted operations:** Deploy the control plane with your own PostgreSQL database and keep worker infrastructure under your control.

> **Development status:** MARS is not yet a production-ready runner platform. Control-plane hosting is the current Linux/amd64 deployment milestone; end-to-end GitHub Actions job execution remains unfinished. See [implementation status](IMPLEMENTATION-STATUS.md) for the precise scope and blockers.

## Get started

- [Development setup and worker commands](docs/development.md)
- [Windows worker runtimes and prerequisites](docs/windows-worker-runtimes.md)
- [Control-plane deployment guide](deploy/control-plane/README.md)
- [Implementation status](IMPLEMENTATION-STATUS.md)

## License

No license has been declared yet.
