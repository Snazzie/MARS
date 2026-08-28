FROM oven/bun:1.2.20 AS build
ARG MARS_RELEASE_MANIFEST=deploy/control-plane/release-manifest.json
ARG MARS_BUILD_ID=unknown
ARG MARS_WINDOWS_SERVICE_HOST_ARTIFACT=
WORKDIR /app
COPY package.json bun.lock ./
COPY apps ./apps
COPY packages ./packages
COPY deploy ./deploy
COPY images ./images
COPY ${MARS_RELEASE_MANIFEST} /release-manifest.json
RUN rm -rf apps/*/node_modules packages/*/node_modules \
  && bun install --frozen-lockfile --linker hoisted \
  && bun install --cwd apps/web --frozen-lockfile --linker hoisted \
  && bun install --cwd apps/control-plane --frozen-lockfile --linker hoisted \
  && bun install --cwd apps/job-agent --frozen-lockfile --linker hoisted \
  && bun run --filter '@mars/web' build \
  && bun run --filter '@mars/control-plane' build \
  && bun run --filter '@mars/job-agent' build \
  && bun build apps/orchestrator/src/index.ts --compile --target=bun-linux-x64 --outfile=/artifacts/mars-orchestrator-linux-x64 \
  && bun build apps/orchestrator/src/index.ts --compile --target=bun-windows-x64 --outfile=/artifacts/mars-orchestrator-windows-x64.exe \
  && bun build apps/orchestrator/src/index.ts --compile --target=bun-darwin-arm64 --outfile=/artifacts/mars-orchestrator-macos-arm64
RUN --mount=type=bind,target=/release-context,readonly \
  if [ -z "$MARS_WINDOWS_SERVICE_HOST_ARTIFACT" ]; then \
    echo "release artifact is unavailable: MARS_WINDOWS_SERVICE_HOST_ARTIFACT is required" >&2; exit 1; \
  fi; \
  if [ ! -f "/release-context/$MARS_WINDOWS_SERVICE_HOST_ARTIFACT" ]; then \
    echo "release artifact is unavailable: /release-context/$MARS_WINDOWS_SERVICE_HOST_ARTIFACT" >&2; exit 1; \
  fi; \
  cp "/release-context/$MARS_WINDOWS_SERVICE_HOST_ARTIFACT" /artifacts/mars-service-host.exe

FROM oven/bun:1.2.20-slim
ARG MARS_BUILD_ID=unknown
WORKDIR /app
COPY --from=build /app/apps/control-plane/dist/index.js ./index.js
COPY --from=build /release-manifest.json ./release-manifest.json
COPY --from=build /app/packages/db/src/migrations ./migrations
COPY --from=build /app/apps/web/dist/index.html /app/web/index.html
COPY --from=build /app/apps/web/dist/index.js /app/web/index.js
COPY --from=build /app/apps/web/dist/index.css /app/web/index.css
COPY --from=build /app/deploy/workers/install-worker.sh ./workers/install-worker.sh
COPY --from=build /app/deploy/workers/install-worker.ps1 ./workers/install-worker.ps1
COPY --from=build /app/deploy/workers/install-worker-macos.sh ./workers/install-worker-macos.sh
COPY --from=build /app/deploy/workers/linux-broker-compose.yaml ./workers/linux-broker-compose.yaml
COPY --from=build /app/deploy/workers/worker-domain.xml ./workers/worker-domain.xml
COPY --from=build /app/deploy/workers/build-windows-container-image-local.ps1 ./workers/build-windows-container-image-local.ps1
COPY --from=build /app/images/jobs/windows/verify-runtime.ps1 ./workers/verify-runtime.ps1
COPY --from=build /app/images/jobs/windows/Containerfile ./workers/Containerfile
COPY --from=build /app/images/jobs/windows/entrypoint.ps1 ./workers/entrypoint.ps1
COPY --from=build /app/apps/job-agent/dist/mars-job-agent ./workers/mars-job-agent.exe
COPY --from=build /artifacts/mars-orchestrator-linux-x64 /app/workers/mars-orchestrator
COPY --from=build /artifacts/mars-orchestrator-windows-x64.exe /app/workers/mars-orchestrator.exe
COPY --from=build /artifacts/mars-orchestrator-macos-arm64 /app/workers/mars-orchestrator-macos-arm64
COPY --from=build /artifacts/mars-service-host.exe /app/workers/mars-service-host.exe
RUN bun -e 'import { createHash } from "node:crypto"; const manifest=JSON.parse(await Bun.file("/app/release-manifest.json").text()); const hash=/^[0-9a-f]{64}$/; const artifacts=[["linux-x64","orchestratorSha256","/app/workers/mars-orchestrator"],["linux-x64","composeSha256","/app/workers/linux-broker-compose.yaml"],["linux-x64","domainTemplateSha256","/app/workers/worker-domain.xml"],["windows-x64","orchestratorSha256","/app/workers/mars-orchestrator.exe"],["windows-x64","serviceHostSha256","/app/workers/mars-service-host.exe"],["macos-arm64","orchestratorSha256","/app/workers/mars-orchestrator-macos-arm64"]]; for (const [platform,field,path] of artifacts) { const record=manifest.platforms?.[platform]; if (record == null) continue; const expected=record[field]; if (typeof expected !== "string") throw new Error(`missing ${platform}.${field}`); if (!hash.test(expected)) throw new Error(`invalid ${platform}.${field}`); const actual=createHash("sha256").update(Buffer.from(await Bun.file(path).arrayBuffer())).digest("hex"); if (actual !== expected) throw new Error(`${platform}.${field} does not match packaged ${path}: expected ${expected}, got ${actual}`); }'
ENV MARS_WINDOWS_CONTAINER_BUILDER=/app/workers/build-windows-container-image-local.ps1
ENV MARS_WINDOWS_CONTAINER_VERIFIER=/app/workers/verify-runtime.ps1
ENV MARS_WINDOWS_CONTAINERFILE=/app/workers/Containerfile
ENV MARS_WINDOWS_CONTAINER_ENTRYPOINT=/app/workers/entrypoint.ps1
ENV MARS_WINDOWS_CONTAINER_JOB_AGENT=/app/workers/mars-job-agent.exe
ENV WEB_ROOT=file:///app/web/
ENV WORKER_INSTALLER_ROOT=file:///app/workers/
ENV WORKER_SERVICE_HOST_EXECUTABLE=file:///app/workers/mars-service-host.exe
ENV WORKER_ORCHESTRATOR_LINUX_X64=file:///app/workers/mars-orchestrator
ENV WORKER_ORCHESTRATOR_WINDOWS_X64=file:///app/workers/mars-orchestrator.exe
ENV WORKER_ORCHESTRATOR_MACOS_ARM64=file:///app/workers/mars-orchestrator-macos-arm64
ENV NODE_ENV=production
ENV DATA_ROOT=/var/lib/mars
ENV MARS_BUILD_ID=$MARS_BUILD_ID
RUN mkdir -p /var/lib/mars && chown bun:bun /var/lib/mars && chmod 700 /var/lib/mars
USER bun
EXPOSE 3000
ENTRYPOINT ["bun","run","index.js"]
