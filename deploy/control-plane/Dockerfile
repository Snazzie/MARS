FROM oven/bun:1.4.0 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY apps ./apps
COPY packages ./packages
RUN rm -rf apps/*/node_modules packages/*/node_modules \
  && bun install --frozen-lockfile --linker hoisted \
  && bun install --cwd apps/web --frozen-lockfile --linker hoisted \
  && bun install --cwd apps/control-plane --frozen-lockfile --linker hoisted \
  && bun run --filter '@mars/web' build \
  && bun run --filter '@mars/control-plane' build

FROM oven/bun:1.4.0-slim
ARG MARS_BUILD_ID=unknown
ARG MARS_WORKER_RELEASE_MANIFEST_URL
ARG MARS_WORKER_CONTRACT_VERSION
WORKDIR /app
COPY --from=build /app/apps/control-plane/dist/index.js ./index.js
COPY --from=build /app/packages/db/src/migrations ./migrations
COPY --from=build /app/apps/web/dist/index.html /app/web/index.html
COPY --from=build /app/apps/web/dist/index.js /app/web/index.js
COPY --from=build /app/apps/web/dist/index.css /app/web/index.css
RUN apt-get update \
  && apt-get install --no-install-recommends -y gosu \
  && rm -rf /var/lib/apt/lists/*
COPY deploy/control-plane/entrypoint.sh /usr/local/bin/mars-control-plane-entrypoint
RUN chmod 755 /usr/local/bin/mars-control-plane-entrypoint
ENV WEB_ROOT=file:///app/web/
ENV NODE_ENV=production
ENV DATA_ROOT=/var/lib/mars
ENV MARS_BUILD_ID=$MARS_BUILD_ID
ENV MARS_WORKER_RELEASE_MANIFEST_URL=$MARS_WORKER_RELEASE_MANIFEST_URL
ENV MARS_WORKER_CONTRACT_VERSION=$MARS_WORKER_CONTRACT_VERSION
HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --retries=6 \
  CMD ["bun", "-e", "const response=await fetch('http://127.0.0.1:3000/api/readyz');process.exit(response.ok?0:1)"]
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/mars-control-plane-entrypoint"]

