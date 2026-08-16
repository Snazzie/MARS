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
COPY --from=build /app/deploy/workers/install-worker-macos.sh /app/workers/install-worker-macos.sh
COPY --from=build /artifacts/whitesmith-orchestrator.exe /app/workers/whitesmith-orchestrator.exe
ENV NODE_ENV=production
ENV WEB_ROOT=/app/web/
ENV WORKER_INSTALLER_ROOT=/app/workers/
ENV WORKER_ORCHESTRATOR_EXECUTABLE=/app/workers/whitesmith-orchestrator.exe
USER bun
EXPOSE 3000
ENTRYPOINT ["bun","run","index.js"]
