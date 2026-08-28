FROM oven/bun:1.2.20 AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN bun install --frozen-lockfile --linker hoisted
RUN mkdir -p packages/contracts/node_modules && rm -f /app/packages/contracts/node_modules/zod && ln -s /app/node_modules/zod /app/packages/contracts/node_modules/zod
RUN bun build apps/orchestrator/src/index.ts --compile --outfile /out/mars-orchestrator

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libvirt-clients qemu-utils ca-certificates && rm -rf /var/lib/apt/lists/* && useradd --system --create-home --uid 10001 mars
COPY --from=build /out/mars-orchestrator /usr/local/bin/mars-orchestrator
USER mars
ENTRYPOINT ["/usr/local/bin/mars-orchestrator", "linux-worker"]
