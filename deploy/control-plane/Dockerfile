FROM oven/bun:1.2.20 AS build
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

FROM oven/bun:1.2.20-slim
ARG MARS_BUILD_ID=unknown
ARG MARS_WORKER_CONTRACT_VERSION=0.1.0
WORKDIR /app
COPY --from=build /app/apps/control-plane/dist/index.js ./index.js
COPY --from=build /app/packages/db/src/migrations ./migrations
COPY --from=build /app/apps/web/dist/index.html /app/web/index.html
COPY --from=build /app/apps/web/dist/index.js /app/web/index.js
COPY --from=build /app/apps/web/dist/index.css /app/web/index.css
ENV WEB_ROOT=file:///app/web/
ENV NODE_ENV=production
ENV DATA_ROOT=/var/lib/mars
ENV MARS_BUILD_ID=$MARS_BUILD_ID
ENV MARS_WORKER_CONTRACT_VERSION=$MARS_WORKER_CONTRACT_VERSION
RUN mkdir -p /var/lib/mars && chown bun:bun /var/lib/mars && chmod 700 /var/lib/mars
USER bun
EXPOSE 3000
ENTRYPOINT ["bun","run","index.js"]

