FROM oven/bun:1.4.0 AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN rm -rf apps/*/node_modules packages/*/node_modules \
  && bun install --frozen-lockfile --linker hoisted \
  && bun install --cwd apps/orchestrator --frozen-lockfile --linker hoisted
RUN mkdir -p packages/contracts/node_modules && rm -f /app/packages/contracts/node_modules/zod && ln -s /app/node_modules/zod /app/packages/contracts/node_modules/zod
RUN bun build apps/orchestrator/src/index.ts --compile --target=bun-linux-arm64 --outfile=/out/mars-orchestrator

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /var/lib/mars/config /var/lib/mars/action-cache
COPY --from=build /out/mars-orchestrator /usr/local/bin/mars-orchestrator
ENTRYPOINT ["/usr/local/bin/mars-orchestrator", "linux-container-worker"]
