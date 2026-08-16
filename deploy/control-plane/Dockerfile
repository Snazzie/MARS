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
RUN bun install --frozen-lockfile \
  && bun run --filter '@whitesmith/web' build \
  && bun run --filter '@whitesmith/control-plane' build \
  && bun build apps/orchestrator/src/index.ts --compile --target=bun-windows-x64 --outfile=/artifacts/whitesmith-orchestrator.exe

FROM oven/bun:1.2.20-slim
WORKDIR /app
COPY --from=build /app/apps/control-plane/dist/index.js ./index.js
COPY --from=build /app/apps/web/dist/index.html /app/web/index.html
COPY --from=build /app/apps/web/dist/index.js /app/web/index.js
COPY --from=build /app/apps/web/dist/index.css /app/web/index.css
COPY --from=build /app/deploy/workers/install-worker.ps1 /app/workers/install-worker.ps1
COPY --from=build /artifacts/whitesmith-orchestrator.exe /app/workers/whitesmith-orchestrator.exe
COPY --from=windows-service-host /src/apps/windows-service-host/target/x86_64-pc-windows-gnu/release/whitesmith-service-host.exe /app/workers/whitesmith-service-host.exe
ENV NODE_ENV=production
ENV WEB_ROOT=/app/web/
ENV WORKER_INSTALLER_ROOT=/app/workers/
ENV WORKER_SERVICE_HOST_EXECUTABLE=/app/workers/whitesmith-service-host.exe
ENV WORKER_ORCHESTRATOR_WINDOWS_X64=/app/workers/whitesmith-orchestrator.exe
USER bun
EXPOSE 3000
ENTRYPOINT ["bun","run","index.js"]
