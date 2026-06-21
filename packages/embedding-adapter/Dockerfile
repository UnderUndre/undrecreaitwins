FROM node:20-alpine AS builder
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/embedding-adapter/package.json ./packages/embedding-adapter/

COPY packages/shared/ ./packages/shared/
COPY packages/embedding-adapter/ ./packages/embedding-adapter/
COPY tsconfig.json ./

RUN pnpm install --frozen-lockfile

RUN pnpm --filter @undrecreaitwins/shared run build && \
    pnpm --filter @undrecreaitwins/embedding-adapter run build

FROM node:20-alpine AS runner
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared ./packages/shared
COPY --from=builder /app/packages/embedding-adapter ./packages/embedding-adapter

EXPOSE 8095
CMD ["node", "packages/embedding-adapter/dist/index.js"]
