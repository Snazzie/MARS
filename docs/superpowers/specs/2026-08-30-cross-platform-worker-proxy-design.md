# Cross-Platform Worker Download Proxy Design

## Goal

Workers and installer scripts obtain every HTTP artifact from the selected control plane. The control plane selects the artifact source: local files in development and immutable release/configured sources in production.

## Boundaries

HTTP artifacts use control-plane endpoints. OCI-native artifacts remain registry references because Docker and Tart require registry protocols:

- Linux broker image remains an OCI reference.
- macOS Tart image remains a Tart/OCI reference.

The control plane injects those references and digests into generated installers; installers never fetch release metadata.

## Linux

The generated installer receives explicit values for broker image, golden image URL/digest, compose URL/hash, and domain-template URL/hash. Every HTTP URL points to the selected control plane.

Development sources are local paths or configured upstream URLs. Repository defaults cover compose and domain XML; a golden image is optional until configured. Production sources come from the release manifest and are proxied through the same routes.

## macOS

The generated installer receives explicit Tart image reference/digest and orchestrator URL/hash. The orchestrator URL points to the control plane. Development uses the locally built macOS orchestrator when present; production uses the packaged release artifact. Tart image metadata comes from development configuration or the release manifest.

## Installer Commands

Enrollment and upgrade commands always download installer scripts from `/api/workers/installer`. Environment-specific source selection is removed from the web client.

## Integrity and Failure

The existing hardened proxy boundary applies to Linux and macOS HTTP artifacts: digest verification before response, DNS pinning, redirect restrictions, time/size/concurrency bounds, immutable snapshots, and cleanup. Missing artifacts return `503 artifact_unavailable`. Development never falls back to GitHub; production may use GitHub or other immutable configured release sources behind the control plane.
