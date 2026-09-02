# Playwright Archive Cache Design

Extend the worker-local runner cache to intercept immutable Playwright browser and tool archives. The current implementation only caches anonymous npm tarballs from `registry.npmjs.org`, so Playwright's Chrome, headless shell, FFmpeg, and Winldd downloads bypass the cache.

## Scope

Cache anonymous `GET` requests for immutable archive paths on the official Playwright download hosts:

- `cdn.playwright.dev`
- `playwright.download.prss.microsoft.com`

The cache covers Chrome for Testing, Chromium headless shell, FFmpeg, Winldd, and future archive names served from the supported Playwright build paths. It does not cache metadata, redirects, arbitrary files, or unrelated endpoints.

## Eligibility and safety

A request is cacheable only when all conditions hold:

- method is `GET`;
- host is an allowlisted Playwright download host or `registry.npmjs.org`;
- URL has no query string or fragment;
- request has no `Authorization`, `Cookie`, or `Range` header;
- path is an approved immutable archive path (`/builds/.../*.zip` or `/dbazure/download/playwright/builds/.../*.zip`);
- upstream returns status `200`;
- upstream has no `Set-Cookie` header; and
- declared `Content-Length`, when present, matches the captured bytes.

Canonical cache keys include the normalized host and pathname, preventing collisions between CDN and fallback URLs. Existing SQLite metadata, object files, TTL refresh, LRU size enforcement, purge generation fencing, and telemetry are reused unchanged.

## Proxy and certificates

Add both Playwright hosts to the intercepted TLS host list and issue them in the worker cache leaf certificate. Route requests for either host through `PackageDownloadCache`; preserve direct forwarding for all other CONNECT targets. Upstream forwarding preserves the original Playwright host and request path rather than forcing the npm registry authority.

## Runtime behavior

`runnerCacheEnabled` continues to control both npm and Playwright archive caching. Disabling bypasses all new fills but retains existing objects. Re-enabling may serve retained entries. Purge removes all package/archive cache entries while leaving the GitHub Actions cache untouched.

## Testing

Add focused cache tests proving:

- each representative Playwright archive class produces one `MISS` followed by a byte-identical `HIT`;
- CDN and fallback hosts have distinct cache keys;
- non-archive paths, query-bearing requests, authenticated requests, and ranged requests bypass caching;
- the proxy intercepts both Playwright hosts over authenticated CONNECT;
- existing npm tarball behavior and Actions-cache isolation remain unchanged.
