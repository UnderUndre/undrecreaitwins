FROM node:20-alpine AS builder
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/memory/package.json ./packages/memory/
COPY packages/core/package.json ./packages/core/
COPY packages/training/package.json ./packages/training/

COPY packages/shared/ ./packages/shared/
COPY packages/memory/ ./packages/memory/
COPY packages/core/ ./packages/core/
COPY packages/training/ ./packages/training/
COPY tsconfig.json ./

RUN pnpm install --frozen-lockfile

RUN pnpm --filter @undrecreaitwins/shared run build && \
    pnpm --filter @undrecreaitwins/memory run build && \
    pnpm --filter @undrecreaitwins/core run build && \
    pnpm --filter @undrecreaitwins/training run build

RUN pnpm prune --prod

FROM node:20-alpine AS runner
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared ./packages/shared
COPY --from=builder /app/packages/memory ./packages/memory
COPY --from=builder /app/packages/core ./packages/core
COPY --from=builder /app/packages/training ./packages/training

CMD ["node", "packages/training/dist/index.js"]
