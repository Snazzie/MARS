FROM oven/bun:1.2.20 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY apps ./apps
COPY packages ./packages
RUN bun install --frozen-lockfile && bun run --filter '@whitesmith/control-plane' build
FROM oven/bun:1.2.20-slim
WORKDIR /app
COPY --from=build /app/apps/control-plane/dist/index.js ./index.js
USER bun
EXPOSE 3000
ENTRYPOINT ["bun","run","index.js"]
