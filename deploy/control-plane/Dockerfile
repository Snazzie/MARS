FROM rust:1.89.0-slim-bookworm AS windows-service-host
RUN apt-get update \
  && apt-get install -y --no-install-recommends gcc-mingw-w64-x86-64 \
  && rustup target add x86_64-pc-windows-gnu \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY apps/windows-service-host ./apps/windows-service-host
RUN cargo build --manifest-path apps/windows-service-host/Cargo.toml --release --locked --target x86_64-pc-windows-gnu

FROM oven/bun:1.2.20 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY apps ./apps
COPY packages ./packages
COPY deploy ./deploy
COPY images ./images
RUN rm -rf apps/*/node_modules packages/*/node_modules \
  && bun install --frozen-lockfile --linker hoisted \
  && bun install --cwd apps/web --frozen-lockfile --linker hoisted \
  && bun install --cwd apps/control-plane --frozen-lockfile --linker hoisted \
  && bun install --cwd apps/job-agent --frozen-lockfile --linker hoisted \
  && bun run --filter '@mars/web' build \
  && bun run --filter '@mars/control-plane' build \
  && bun run --filter '@mars/job-agent' build \
  && bun build apps/orchestrator/src/index.ts --compile --target=bun-windows-x64 --outfile=/artifacts/mars-orchestrator.exe

ARG MARS_BUILD_ID=unknown
FROM oven/bun:1.2.20-slim
ARG MARS_BUILD_ID=unknown
WORKDIR /app
COPY --from=build /app/apps/control-plane/dist/index.js ./index.js
COPY --from=build /app/packages/db/src/migrations ./migrations
COPY --from=build /app/deploy/control-plane/release-manifest.json ./release-manifest.json
COPY --from=build /app/apps/web/dist/index.html /app/web/index.html
COPY --from=build /app/apps/web/dist/index.js /app/web/index.js
COPY --from=build /app/apps/web/dist/index.css /app/web/index.css
COPY --from=build /app/deploy/workers/install-worker.ps1 ./workers/install-worker.ps1
COPY --from=build /app/deploy/workers/build-windows-container-image-local.ps1 ./workers/build-windows-container-image-local.ps1
COPY --from=build /app/images/jobs/windows/verify-runtime.ps1 ./workers/verify-runtime.ps1
COPY --from=build /app/images/jobs/windows/Containerfile ./workers/Containerfile
COPY --from=build /app/images/jobs/windows/entrypoint.ps1 ./workers/entrypoint.ps1
COPY --from=build /app/apps/job-agent/dist/mars-job-agent ./workers/mars-job-agent.exe
COPY --from=build /artifacts/mars-orchestrator.exe /app/workers/mars-orchestrator.exe
COPY --from=windows-service-host /src/apps/windows-service-host/target/x86_64-pc-windows-gnu/release/mars-service-host.exe /app/workers/mars-service-host.exe
ENV MARS_WINDOWS_CONTAINER_BUILDER=/app/workers/build-windows-container-image-local.ps1
ENV MARS_WINDOWS_CONTAINER_VERIFIER=/app/workers/verify-runtime.ps1
ENV MARS_WINDOWS_CONTAINERFILE=/app/workers/Containerfile
ENV MARS_WINDOWS_CONTAINER_ENTRYPOINT=/app/workers/entrypoint.ps1
ENV MARS_WINDOWS_CONTAINER_JOB_AGENT=/app/workers/mars-job-agent.exe
ENV WEB_ROOT=file:///app/web/
ENV WORKER_INSTALLER_ROOT=file:///app/workers/
ENV WORKER_SERVICE_HOST_EXECUTABLE=file:///app/workers/mars-service-host.exe
ENV WORKER_ORCHESTRATOR_WINDOWS_X64=file:///app/workers/mars-orchestrator.exe
ENV NODE_ENV=production
ENV DATA_ROOT=/var/lib/mars
ENV MARS_BUILD_ID=$MARS_BUILD_ID
RUN mkdir -p /var/lib/mars && chown bun:bun /var/lib/mars && chmod 700 /var/lib/mars
USER bun
EXPOSE 3000
ENTRYPOINT ["bun","run","index.js"]
