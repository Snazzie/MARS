FROM oven/bun:1.2.20 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY apps ./apps
COPY packages ./packages
RUN bun install --frozen-lockfile && bun run --filter '@whitesmith/web' build && bun run --filter '@whitesmith/control-plane' build && bun build apps/orchestrator/src/index.ts --compile --target=bun-windows-x64 --outfile /artifacts/whitesmith-orchestrator.exe
FROM oven/bun:1.2.20-slim
WORKDIR /app
COPY --from=build /app/apps/control-plane/dist/index.js ./index.js
COPY --from=build /artifacts/whitesmith-orchestrator.exe ./workers/whitesmith-orchestrator.exe
ENV WEB_ROOT=/app/web/
USER bun
EXPOSE 3000
ENTRYPOINT ["bun","run","index.js"]
