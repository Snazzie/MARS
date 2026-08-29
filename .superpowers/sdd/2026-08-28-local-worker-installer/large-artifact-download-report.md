# Large Artifact Download Regression

## Root cause

`/api/workers/windows-container-job-agent` returned a `Bun.file(...)` body through Hono without an explicit size. Bun therefore emitted a chunked HTTP response with no `Content-Length`. Windows PowerShell `Invoke-WebRequest` can close the transport while consuming this large chunked executable response.

There was a second boundary detail: the control-plane security middleware used `c.header(...)` after `await next()`. Hono clones a finalized response when those headers are applied. That clone preserves the body as a generic stream, so Bun strips a manually supplied `Content-Length` while writing the network response. The middleware now mutates `c.res.headers` in place, preserving the `BunFile` body and its streaming behavior.

## Change

- `packagedResponse` now constructs `Bun.file(path)` once, creates `new Response(file)`, and sets `content-length` from `file.size` without reading, buffering, or copying the artifact.
- Existing `cache-control: no-store`, content type, content disposition, and `X-Content-SHA256` headers remain intact.
- Security headers are applied in place to avoid converting the Bun file response into a generic stream.
- Added a focused app regression test asserting Content-Length equals the fixture's `Bun.file(...).size`.

## Verification

TDD red before implementation:

```text
bun test apps/control-plane/src/http/app.test.ts -t "sets Content-Length for large Windows job-agent downloads"
FAIL: Expected: "35"; Received: null
```

Focused HTTP tests after implementation:

```text
bun test apps/control-plane/src/http/app.test.ts
52 pass, 0 fail, 127 expect() calls
```

Exact endpoint curl smoke used the route `/api/workers/windows-container-job-agent` over a running Bun HTTP server with a streamed fixture:

```text
curl.exe -sS -D - -o NUL http://127.0.0.1:38765/api/workers/windows-container-job-agent
HTTP/1.1 200 OK
Content-Type: application/octet-stream
Cache-Control: no-store
Content-Disposition: attachment; filename="mars-job-agent.exe"
X-Content-SHA256: f4174cfc46eb866b84978ad1049b805f2b58848c0c1e1b2c51aeca1ef4c79cfa
content-length: 41
```

The smoke response had no `Transfer-Encoding: chunked`; the fixture body remained streamed from `Bun.file`.

## Concerns

The local smoke used a 41-byte fixture because the repository does not package the 94.06 MB production executable in this checkout. The focused test and network path exercise the same response boundary and headers; no production artifact was buffered or copied.
