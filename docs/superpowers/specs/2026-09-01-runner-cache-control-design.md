# Runner Cache Control Design

Enable transparent public npm tarball caching by default for development, allow control-plane users to disable or purge the package cache for an individual worker, and let them configure its retention and size.

## Configuration

Extend the worker cache configuration:

```ts
cache: {
  ttlSeconds: number;
  runnerCacheEnabled: boolean;
  runnerCacheMaxGiB: number;
}
```

`runnerCacheEnabled` defaults to `true`, so existing development workers are enabled without environment changes. `ttlSeconds` remains the shared cache TTL and is configurable per worker. `runnerCacheMaxGiB` is a positive safe integer GiB cap for package objects and defaults to `20`. It controls transparent caching of dependencies downloaded by jobs on that worker. It does not disable the existing GitHub Actions cache protocol.

The settings are persisted in the worker's desired configuration, delivered through the existing `worker.configure` command, and acknowledged in the worker's observed configuration. Applying them does not restart listeners.

## Runtime behavior

- `runnerCacheEnabled: true`: eligible anonymous immutable npm tarballs use the worker-local package cache.
- `runnerCacheEnabled: false`: eligible package requests pass directly upstream; no new package fills occur.
- Disabling retains existing package objects and metadata.
- Re-enabling can reuse retained objects and resume fills.
- GitHub Actions cache routes, status, snapshots, and telemetry remain unchanged.

## Purge action

Add a per-worker authenticated control-plane action, exposed in the worker management surface as `Purge runner cache`.

The control plane sends a worker command instead of deleting worker files directly. The worker purges package metadata and object files below `<MARS_ACTION_CACHE_ROOT>/packages` only; the Actions cache is untouched. Purge is idempotent, audited, and acknowledged through the existing worker command lifecycle.

Active fills finish safely but are not published after a purge. Requests arriving after purge use the current `runnerCacheEnabled` setting.

## Verification

Add coverage for:

- default-enabled configuration;
- worker configure and acknowledgement round-trip;
- disabled pass-through;
- re-enable and retained-object reuse;
- per-worker purge and Actions-cache isolation;
- idempotent purge;
- concurrent fills and restart recovery;
- unchanged existing cache behavior.
