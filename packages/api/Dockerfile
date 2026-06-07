FROM node:20-bookworm-slim AS builder
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/memory/package.json ./packages/memory/
COPY packages/core/package.json ./packages/core/
COPY packages/training/package.json ./packages/training/
COPY packages/api/package.json ./packages/api/

COPY packages/shared/ ./packages/shared/
COPY packages/memory/ ./packages/memory/
COPY packages/core/ ./packages/core/
COPY packages/training/ ./packages/training/
COPY packages/api/ ./packages/api/
COPY tsconfig.json ./

RUN pnpm install --frozen-lockfile

RUN pnpm --filter @undrecreaitwins/shared run build && \
    pnpm --filter @undrecreaitwins/memory run build && \
    pnpm --filter @undrecreaitwins/core run build && \
    pnpm --filter @undrecreaitwins/training run build && \
    pnpm --filter @undrecreaitwins/api run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip python3-venv pipx ripgrep && \
    rm -rf /var/lib/apt/lists/*

ENV PIPX_BIN_DIR=/usr/local/bin
RUN pipx install 'hermes-agent[acp]==0.15.1' && \
    hermes acp --check

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared ./packages/shared
COPY --from=builder /app/packages/memory ./packages/memory
COPY --from=builder /app/packages/core ./packages/core
COPY --from=builder /app/packages/training ./packages/training
COPY --from=builder /app/packages/api ./packages/api

EXPOSE 8090
CMD ["node", "packages/api/dist/server.js"]
