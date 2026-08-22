# Worker-local GitHub Actions cache mirror

## Context
Whitesmith will transparently replace GitHub's Actions cache service for unmodified `actions/cache@v4`/`@v5` and cache-enabled first-party setup actions. Both save and restore traffic is intercepted inside each disposable job, but cache indexes and archive bytes persist only on that job's worker; the control plane stores configuration and a searchable metadata projection, never cache bytes. Each lookup hit refreshes sliding expiry, with a centrally configurable per-worker TTL default of 172800 seconds (2 days), no size-based eviction, and complete paginated visibility of repository URL, cache key preview, size, last hit, and expiry.

## Approach
1. **Extend the durable worker configuration and cache protocol contracts.**
   - In `packages/contracts/src/orchestration.ts`, add strict `WorkerCacheConfiguration = { ttlSeconds: z.number().int().positive().safe().default(172800) }`, add `cache: WorkerCacheConfiguration.default({ ttlSeconds: 172800 })` to `WorkerConfiguration`, and add required `cache` to `WorkerConfigurePayload`. Keep the schema default so previously persisted desired configurations parse as the 2-day default; configuration revision hashing then makes later TTL changes ordinary clean revisions.
   - Add strict guest-only `WorkerCacheProxy = { proxyUrl: z.string().url(), cacheBaseUrl: z.string().url(), caCertificatePem: z.string().min(1), expiresAt: z.string().datetime() }` and allow it only in the bootstrap object written by a worker after decrypting `LeaseBootstrapEnvelope`; do not add proxy credentials, CA material, or worker addresses to the control-plane lease envelope.
   - Add strict worker cache telemetry contracts: `WorkerCacheEntryProjection`, `WorkerCacheStatus`, and event payloads `worker.cache_entry_upsert`, `worker.cache_entry_deleted`, `worker.cache_snapshot_begin`, `worker.cache_snapshot_page`, and `worker.cache_snapshot_end`. Cap snapshot pages at 100 entries and require `snapshotId`, page sequence, and final counts so every frame remains below the existing 256 KiB WebSocket limit.
   - Use these exact shared worker/control-plane contracts; all byte counts and GitHub numeric IDs are decimal strings to avoid JavaScript int64 loss:
     ```ts
     type WorkerCacheConfiguration = { ttlSeconds: number }; // positive safe integer; default 172800
     type WorkerCacheProxy = {
       proxyUrl: string;             // credential-bearing HTTP proxy URL; guest-only
       cacheBaseUrl: string;         // worker HTTPS data origin
       caCertificatePem: string;     // public worker CA only
       expiresAt: string;            // lease credential expiry
     };
     type WorkerCacheEntryProjection = {
       entryId: string;              // UUID
       githubRepositoryId: string;   // decimal int64
       cacheKeyPreview: string;      // printable, <=160 chars
       cacheKeyHash: string;         // lowercase SHA-256 hex
       scopePreview: string;         // printable, <=160 chars
       scopeHash: string;            // lowercase SHA-256 hex
       versionHash: string;          // lowercase SHA-256 hex
       sizeBytes: string;            // decimal nonnegative int64
       createdAt: string;
       lastAccessedAt: string;
       expiresAt: string;            // offset datetimes
     };
     type WorkerCacheStatus = {
       generation: string;           // persistent UUID, replaced only when local index is recreated
       ready: boolean;
       ttlSeconds: number;
       proxyOrigin: string;          // never includes lease credentials
       cacheBaseUrl: string;
       sizeBytes: string;
       entryCount: number;           // nonnegative safe integer
       observedAt: string;
       error: string | null;         // redacted, <=1000 chars
     };
     type WorkerCacheTelemetry =
       | { type: "worker.cache_entry_upsert"; payload: { generation: string; entry: WorkerCacheEntryProjection } }
       | { type: "worker.cache_entry_deleted"; payload: { generation: string; entryId: string } }
       | { type: "worker.cache_snapshot_begin"; payload: { snapshotId: string; status: WorkerCacheStatus } }
       | { type: "worker.cache_snapshot_page"; payload: { snapshotId: string; sequence: number; entries: WorkerCacheEntryProjection[] } }
       | { type: "worker.cache_snapshot_end"; payload: { snapshotId: string; pageCount: number; entryCount: number; sizeBytes: string } };
     ```
   - Extend `apps/control-plane/src/worker-requests.ts` command construction/reconnect replay and all apply/ack callsites—`apps/orchestrator/src/windows-agent.ts:applyWindowsWorkerConfiguration`, `mac-agent.ts:applyWorkerConfigure`, and `linux-agent.ts:applyLinuxWorkerConfigure`—to apply the TTL to the live cache service and echo the exact `cache` object in `WorkerConfiguredPayload.observed`. No compatibility alias or second cache-settings channel remains.

2. **Run one persistent, authenticated cache service on every worker.**
   - Add `apps/orchestrator/src/action-cache/service.ts` exporting `startActionCacheService(options): Promise<ActionCacheService>`, where `ActionCacheService` exposes `status(): WorkerCacheStatus`, `applyTtl(ttlSeconds: number): Promise<void>`, `registerLease(leaseId: string, expiresAt: string): WorkerCacheProxy`, `unregisterLease(leaseId: string): void`, `snapshotPages(pageSize: number): AsyncIterable<WorkerCacheEntryProjection[]>`, and `close(): Promise<void>`. No equivalent service exists; keep protocol routing, storage, and lifecycle under `apps/orchestrator/src/action-cache/` rather than extending dormant `template-cache.ts` into an unrelated abstraction.
   - Add `apps/orchestrator/src/action-cache/store.ts` backed by `bun:sqlite` in WAL mode. Resolve the root from `WHITESMITH_ACTION_CACHE_ROOT`, otherwise `%ProgramData%\Whitesmith\action-cache` on Windows, `$HOME/Library/Application Support/Whitesmith/action-cache` on macOS, and `/var/lib/whitesmith/action-cache` on Linux. Use a versioned local schema with immutable entries keyed by `(githubRepositoryId, scope, cacheKey, version)`, upload parts, one persistent random generation ID, byte size, and created/updated/last-accessed/expiry timestamps. Store archives, blocks, CA keys, and signing secrets only under UUID/hash-derived paths; never derive a path from repository, scope, cache key, version, URL, or block ID.
   - Add `"jose": "^6.0.10"` and `"node-forge": "^1.4.0"` to `apps/orchestrator/package.json`, plus `"@types/node-forge": "^1.3.11"` as a development dependency. Use `jose` with `createRemoteJWKSet` to verify the original GitHub runtime JWT against issuer `https://token.actions.githubusercontent.com` and JWKS URL `https://token.actions.githubusercontent.com/.well-known/jwks`; permit `WHITESMITH_CACHE_TOKEN_ISSUER` and `WHITESMITH_CACHE_JWKS_URL` overrides for GitHub endpoint changes, but reject invalid values at startup. Parse `repository_id` plus the `ac` scope/permission claim; permission 1 may restore and permission 2 may save. Use node-forge only to create a persistent per-worker CA and short-lived leaf certificates for intercepted Results hosts and the advertised cache HTTPS endpoint; private keys stay readable only by the worker process and never enter a guest.
   - Bind the authenticated HTTP CONNECT proxy to `0.0.0.0:${WHITESMITH_CACHE_PROXY_PORT:-8788}` and the HTTPS data service to `0.0.0.0:${WHITESMITH_CACHE_DATA_PORT:-8789}`. Discover the advertise host by opening a short-lived `node:net`/`node:tls` connection to the configured control-plane origin and reading the socket's `localAddress`; construct `http://<host>:<proxyPort>` and `https://<host>:<dataPort>`. `WHITESMITH_CACHE_PROXY_URL` and `WHITESMITH_CACHE_ADVERTISE_URL` override those origins together for NAT or unusual routing; require both or neither, and reject paths, query strings, fragments, userinfo, non-HTTP(S) schemes, or different hostnames. Report both effective origins in `WorkerCacheStatus`. At worker startup, probe index writes, object write/fsync/rename/delete, certificate loading, both listeners, and the advertised data endpoint; failed cache readiness makes the worker runtime not ready so jobs cannot silently fall back to GitHub cache.
   - Give each active lease a random proxy username/token and reject missing, expired, wrong-lease, or reused credentials. Bind/cache traffic may be reachable from guest networks, but every cache RPC still requires a valid GitHub runtime JWT and every data operation requires an operation-specific signed grant. Unregister credentials in lease cleanup even when lease preservation is enabled.
   - Wire the optional root/port/advertise/JWKS overrides through `deploy/workers/install-worker.ps1` service environment, `install-worker-macos.sh` LaunchAgent environment, and `linux-broker-compose.yaml`; defaults require no new installer arguments. On Windows, create/update one `Whitesmith Worker Cache` inbound firewall rule for TCP 8788–8789, the orchestrator executable, Domain/Private profiles, and `LocalSubnet`, and remove obsolete duplicate rules during reinstall. The per-lease credential, JWT, and signed grants remain mandatory even inside the firewall scope.

3. **Implement the GitHub cache-service-v2 behavior locally, including Azure-compatible uploads.**
   - In `apps/orchestrator/src/action-cache/routes.ts`, implement JSON Twirp POST handlers exactly at `/twirp/github.actions.results.api.v1.CacheService/CreateCacheEntry`, `/FinalizeCacheEntryUpload`, and `/GetCacheEntryDownloadURL`. Preserve GitHub field names `signed_upload_url`, `signed_download_url`, `matched_key`, `size_bytes`, and `entry_id`; return Twirp JSON errors `{ code, msg, meta }`. Unknown cache-service methods or protobuf content types return an explicit unsupported response and are never forwarded to GitHub cache.
   - Parse and emit these exact cache-service-v2 JSON wire contracts (protobuf field names), while authorizing repository/scope exclusively from the verified token rather than trusting request metadata:
     ```ts
     type CacheMetadataWire = {
       repository_id: string; // decimal int64
       scope: Array<{ scope: string; permission: string }>; // permission is decimal int64
     };
     type CreateCacheEntryRequestWire = { metadata: CacheMetadataWire; key: string; version: string };
     type CreateCacheEntryResponseWire = { ok: boolean; signed_upload_url?: string; message?: string };
     type FinalizeCacheEntryUploadRequestWire = {
       metadata: CacheMetadataWire; key: string; size_bytes: string; version: string;
     };
     type FinalizeCacheEntryUploadResponseWire = { ok: boolean; entry_id?: string; message?: string };
     type GetCacheEntryDownloadURLRequestWire = {
       metadata: CacheMetadataWire; key: string; restore_keys: string[]; version: string;
     };
     type GetCacheEntryDownloadURLResponseWire = {
       ok: boolean; signed_download_url?: string; matched_key?: string;
     };
     ```
   - `CreateCacheEntry` selects a verified write scope, reserves one immutable entry, and returns `{ ok:false }` for an existing key/version or active conflict. Its signed URL points to the same worker's HTTPS upload route. Accept cache keys of 1–512 UTF-8 characters, versions of 1–128 characters, at most 10 restore keys, and scopes of 1–1024 characters; treat sizes as decimal int64 strings or safe integers and reject negative/overflowing values.
   - Implement Azure Block Blob-compatible `PUT ?comp=block&blockid=...` and `PUT ?comp=blocklist` routes. Stream each block to an exclusive temporary file. Accept only the two known base64-decoded block-ID layouts: a 48-byte value whose decimal zero-based index begins at byte 36, or a 64-byte value whose big-endian uint32 index begins at byte 16; map index to part number `index+1`, enforce 1–10,000, and reject duplicate part numbers with different IDs. Parse `<BlockList><Latest>…</Latest></BlockList>` without external entities, require each declared block exactly once in contiguous `0..n-1` order, concatenate through streams into a same-filesystem temporary archive, fsync, verify declared size, atomically rename, and transition `uploading -> blob_ready -> ready`. Interrupted/invalid uploads never publish a ready entry.
   - `GetCacheEntryDownloadURL` reproduces GitHub matching within verified repository/scopes: exact primary key, primary-prefix newest-first, then each restore key in caller order as exact then prefix newest-first, always requiring the same version and `ready` state. Escape SQL `LIKE` metacharacters. Verify the object exists before returning a hit; delete dangling/corrupt metadata and continue searching.
   - A successful lookup is the cache hit: atomically set `lastAccessedAt=now` and `expiresAt=now+ttlSeconds`, then issue a 15-minute download grant. The data route supports full `GET`, `HEAD`, and one RFC byte range (`206`, `Content-Range`, `Accept-Ranges`, exact lengths; invalid ranges return `416`). A TTL change recomputes every ready entry's expiry from its existing `lastAccessedAt`, then sweeps immediately.
   - Run lazy expiry before matching plus a periodic sweeper that deletes ready entries whose `expiresAt <= now` and uploads idle for one hour. Delete object/parts before metadata and leave a retryable deleting state if filesystem deletion fails. Do not add byte caps, LRU capacity eviction, GitHub storage fallback, S3, MinIO, or control-plane archive storage.

4. **Intercept only Actions cache RPCs without modifying workflows or the official runner.**
   - Add the proxy descriptor to the protected per-guest bootstrap written by `apps/orchestrator/src/windows-container.ts`, `hyperv.ts`, and the Tart full-bootstrap path in `tart.ts`; carry it through `apps/orchestrator/src/runtime.ts:Lease`, `lease-lifecycle.ts`, and `mac-agent.ts`. The worker creates/registers the per-lease credential immediately before driver creation and unregisters it in the common cleanup `finally`.
   - Refactor `apps/job-agent/src/bootstrap.ts` and `linux-guest.ts` through one `runRunnerWithWorkerCache(...)` helper. Write the worker CA to a private temporary file, set uppercase/lowercase `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and `NODE_EXTRA_CA_CERTS` only for the official runner process, preserve existing JIT config injection, and always remove the CA file in `finally`. This is sufficient for the Node-based supported cache/setup actions; do not mutate machine-wide trust stores.
   - The worker CONNECT proxy tunnels all non-target hosts byte-for-byte. For Results hosts under the validated `*.actions.githubusercontent.com` suffix, terminate TLS with a worker-CA leaf and route only the three exact JSON cache Twirp methods to the local handlers while preserving method, body, content type, and Authorization. Tunnel every non-cache Results method unchanged so workflow artifacts/logging continue to GitHub. Never log runtime tokens, authorization headers, cache bodies, grants, JIT configuration, CA private material, or raw request URLs.
   - Cache operation is fail-closed: inability to start the worker cache/proxy marks the worker unready; inability to install the worker CA for a job or configure its proxy fails guest bootstrap rather than launching a runner that could use GitHub cache. Recognized unsupported cache protocols return an explicit error. Docker BuildKit `type=gha`, `sccache`, legacy v1, and arbitrary package downloads are not silently treated as supported Actions-cache traffic.
   - Establish job-to-host reachability before runner launch by probing the advertised cache health endpoint with the per-lease credential. Windows container and macOS Tart are the first live paths because they currently launch end to end. Update the Linux libvirt and Windows Hyper-V bootstrap propagation code and tests, but do not claim live support until their existing enrollment/channel and network/scheduling blockers are independently completed.

5. **Synchronize complete cache metadata to the control plane without moving bytes.**
   - Add migration `packages/db/src/migrations/0006_worker_action_cache.sql`, its journal entry, and matching `drizzle-schema.ts` models for `worker_cache_status`, `worker_cache_entries`, and `worker_cache_snapshot_entries`. Main entries use `(worker_id, entry_id)` as the key and store GitHub repository ID, printable/truncated key preview, cache-key hash, scope preview/hash, version hash, size, created/last-hit/expiry timestamps, and observed generation; never store raw runtime tokens, grants, CA material, archive bytes, or signed URLs.
   - On fill, hit, and delete, the worker emits idempotent single-entry deltas asynchronously; telemetry failure never fails cache I/O. On authenticated reconnect, serialize a consistent SQLite snapshot, queue mutations that occur during it, send begin/pages/end, then flush queued deltas. The control plane stages pages by `(worker_id,snapshot_id)`, verifies page sequence/count at end, atomically replaces that worker's main projection, and discards incomplete staging snapshots. This prevents partial inventory after reconnect or control-plane restart.
   - Extend `apps/control-plane/src/index.ts`/worker event handling to validate these events and update projections. Derive aggregate bytes/count from completed worker status/snapshots, and retain the worker-reported effective TTL and advertised URL for diagnostics; desired TTL remains authoritative in `workers.desired_configuration`.
   - Extend `packages/contracts/src/dashboard.ts`, `packages/db/src/dashboard.ts`, and dashboard routes with a global-admin cache summary on `WorkerDetail` plus `GET /api/workers/:workerId/cache?cursor=<opaque>&limit=<1..100>&query=<text>`. Join `github_repository_id` to known dashboard repositories and return `repositoryUrl=https://github.com/<fullName>` when known, otherwise a null URL plus numeric repository ID. Order by last hit descending, then entry ID for stable cursor pagination.
   - Use these exact control-plane view contracts in `packages/contracts/src/dashboard.ts`:
     ```ts
     type WorkerCacheSummary = {
       desiredTtlSeconds: number;
       effectiveTtlSeconds: number | null;
       ready: boolean;
       proxyOrigin: string | null;
       cacheBaseUrl: string | null;
       sizeBytes: string;
       entryCount: number;
       observedAt: string | null;
       error: string | null;
     };
     type DashboardWorkerCacheEntry = {
       entryId: string;
       githubRepositoryId: string;
       repositoryFullName: string | null;
       repositoryUrl: string | null;
       cacheKeyPreview: string;
       cacheKeyHash: string;
       scopePreview: string;
       scopeHash: string;
       versionHash: string;
       sizeBytes: string;
       createdAt: string;
       lastAccessedAt: string;
       expiresAt: string;
     };
     type DashboardWorkerCachePage = {
       items: DashboardWorkerCacheEntry[];
       nextCursor: string | null;
     };
     // WorkerDetail gains: cache: WorkerCacheSummary
     ```
     Encode `nextCursor` as opaque base64url JSON `{ lastAccessedAt, entryId }`; reject malformed cursors with the existing structured 400 response. `query` performs case-insensitive search across repository full name, key/scope preview, and exact key/scope/version hashes.
   - Sanitize cache-key/scope previews on the worker before telemetry: normalize to printable UTF-8, remove controls, cap each at 160 characters, and send a SHA-256 for stable search/identity. The admin UI labels previews as workflow-provided metadata; signed URLs and query strings are never displayed.

6. **Expose TTL editing and inventory on the existing worker surface.**
   - Extend `apps/web/src/components/WorkerConfigurationForm.tsx` with required integer `Cache TTL (hours)` input, initialized from desired configuration and defaulting to 48; convert exactly to `ttlSeconds` in the existing `WorkerConfigurationInput`. Keep current capacity/platform validation and the same idempotent configure endpoint.
   - Add a cache panel to `WorkerCard.tsx`: desired/effective TTL, service URL, total formatted bytes, entry count, observed time, and an expandable lazy-loaded/searchable paginated table showing repository link/ID, key preview, scope preview, version hash, size, last hit, and expiry. Use the existing query invalidation/polling conventions; cache inventory remains read-only.
   - Show applying/error state when desired and applied TTL revisions differ, unavailable state when cache readiness/status is missing, and empty state when the worker has zero entries. Do not add manual purge, capacity controls, cross-worker sharing, or scheduling affinity.

## Critical files & anchors
- `packages/contracts/src/orchestration.ts:WorkerConfiguration`, `WorkerConfigurePayload`, `WorkerEventPayload` — strict configuration, guest proxy, and telemetry contracts shared end to end.
- `apps/orchestrator/src/action-cache/service.ts:startActionCacheService` — new worker-owned proxy/cache lifecycle and the only owner of archive bytes.
- `apps/job-agent/src/bootstrap.ts:consumeJitConfig` / `consumeGuestJitConfig` — common official-runner boundary for proxy and CA environment injection.
- `apps/control-plane/src/index.ts` worker WebSocket receiver — cache delta/snapshot ingestion and authenticated worker identity boundary.
- `apps/web/src/components/WorkerCard.tsx` — existing admin worker surface for cache status and lazy inventory.

## Verification
- From the repository root, run focused contracts/configuration tests:
  `bun test packages/contracts/src/orchestration.test.ts apps/control-plane/src/worker-requests.persistence.test.ts apps/control-plane/src/worker-configuration-reconcile.test.ts apps/control-plane/src/worker-requests.ack.test.ts apps/orchestrator/src/windows-agent.test.ts apps/orchestrator/src/mac-agent.test.ts apps/orchestrator/src/linux-agent.test.ts`.
  Required behavior: omitted historical cache config parses to 172800 seconds; a TTL edit changes the revision; reconnect replays it; each worker applies and exactly acknowledges it.
- Run the new worker-cache behavioral suite:
  `bun test apps/orchestrator/src/action-cache apps/job-agent/src/bootstrap.test.ts`.
  Use an injected clock, local JWKS/runtime-token fixture, temp root, and literal snake_case request/response fixtures for all three Twirp contracts. Prove unknown JSON fields are ignored like protobuf JSON, while missing metadata, empty key/version, malformed int64, and more than 10 restore keys are rejected; int64 values round-trip as decimal strings; request metadata cannot escalate token repository/scope permissions; repository/scope isolation; exact/prefix/restore-key ordering; immutable conflicts; out-of-order Azure blocks reassemble byte-identically; declared-size mismatch never publishes; full/HEAD/range download; expired/tampered grants; same-hit expiry moves from `T+48h` to `T2+48h`; TTL reduction immediately expires old entries; abandoned uploads and corrupt/missing objects clean up; no size-cap eviction; non-cache CONNECT traffic tunnels; supported cache RPCs never reach the fake GitHub origin; unsupported cache protocols do not fall back.
- Run database/API/UI projection tests:
  `bun test packages/db/src/migrate.test.ts packages/db/src/dashboard.test.ts apps/control-plane/src/dashboard-api.test.ts apps/web/src/api.test.ts apps/web/src/components/WorkerCard.test.tsx`.
  Prove every `WorkerCacheTelemetry` variant and `WorkerCacheSummary`/`DashboardWorkerCachePage` field round-trips through strict schemas; paged snapshot swap is atomic; interrupted snapshots preserve the old projection; deltas are idempotent; unknown repository IDs have no fabricated URL; malformed cursors return 400; cursor pagination is stable; cache-key previews are bounded/sanitized; TTL submission is 48 hours by default; and empty/unavailable/applying states render distinctly.
- Run `bun run typecheck` from the repository root. Expected: every workspace typechecks with strict cache configuration, worker events, bootstrap propagation, and dashboard DTOs.
- Build and launch the actual Windows worker/orchestrator path, then run a manual-only workflow using unmodified `actions/cache@v5` on a pool pinned to that worker: first run saves a known directory under a unique key; remove the job filesystem; second run restores identical bytes and reports `cache-hit == 'true'`. Observe the worker cache directory growing only after save, no requests to GitHub cache/blob endpoints in proxy diagnostics, and the second restore served from worker disk. Trigger a third hit after advancing/waiting across a test-configured short TTL boundary and confirm its expiry moves forward; then allow expiry and confirm the worker deletes bytes and the control-plane inventory row disappears.
- Open the real dashboard worker card in Chromium after the smoke run. Confirm the effective service URL, desired/effective TTL, aggregate size/count, repository link, key preview, last-hit time, and expiry match the worker state; change TTL in the form and observe applying -> ready plus recomputed expiry. Repeat the live save/restore smoke on macOS Tart when a reachable enrolled worker is available. Report Linux libvirt and Windows Hyper-V as propagation-tested only until their pre-existing runtime blockers are resolved.

## Assumptions & contingencies
- Supported clients are current JSON cache-service-v2 calls from unmodified `actions/cache@v4`/`@v5` and cache-enabled first-party setup actions. If a supported bundled client uses protobuf during implementation, add protobuf decoding/encoding for the same three methods behind the existing handlers; never route recognized cache traffic to GitHub.
- Auto-discovery uses the local address selected for the worker's control-plane connection. If a guest cannot reach that address, `WHITESMITH_CACHE_ADVERTISE_URL` is the predetermined override; cache readiness remains false until its per-lease guest probe succeeds.
- Cache contents are intentionally worker-affine. A key saved on worker A is a miss on worker B; do not add cross-worker replication, scheduler affinity, or control-plane data relay.
- Cache capacity is TTL-only by product choice. Disk exhaustion makes new saves fail without deleting unexpired entries; existing readable entries remain available and worker status reports the filesystem error.
