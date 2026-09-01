FROM oven/bun:1.4.0 AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN rm -rf apps/*/node_modules packages/*/node_modules \
  && bun install --frozen-lockfile --linker hoisted \
  && bun install --cwd apps/orchestrator --frozen-lockfile --linker hoisted
RUN mkdir -p packages/contracts/node_modules && rm -f /app/packages/contracts/node_modules/zod && ln -s /app/node_modules/zod /app/packages/contracts/node_modules/zod
RUN bun build apps/orchestrator/src/index.ts --compile --outfile /out/mars-orchestrator

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libvirt-clients qemu-utils ca-certificates && rm -rf /var/lib/apt/lists/* && groupadd --gid 10001 mars && useradd --system --create-home --uid 10001 --gid mars mars && mkdir -p /var/lib/mars/config /var/lib/mars/golden /var/lib/mars/clones /var/lib/mars/channels /var/lib/mars/action-cache && chown -R 10001:10001 /var/lib/mars
COPY --from=build /out/mars-orchestrator /usr/local/bin/mars-orchestrator
USER mars
EXPOSE 8788 8789
ENTRYPOINT ["/usr/local/bin/mars-orchestrator", "linux-worker"]
