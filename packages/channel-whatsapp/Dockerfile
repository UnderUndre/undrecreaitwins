FROM node:20-alpine AS builder
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/memory/package.json ./packages/memory/
COPY packages/core/package.json ./packages/core/
COPY packages/channel-whatsapp/package.json ./packages/channel-whatsapp/

RUN pnpm install --frozen-lockfile

COPY packages/shared/ ./packages/shared/
COPY packages/memory/ ./packages/memory/
COPY packages/core/ ./packages/core/
COPY packages/channel-whatsapp/ ./packages/channel-whatsapp/
COPY tsconfig.json ./

RUN pnpm --filter @undrecreaitwins/shared run build
RUN pnpm --filter @undrecreaitwins/memory run build
RUN pnpm --filter @undrecreaitwins/core run build
RUN pnpm --filter @undrecreaitwins/channel-whatsapp run build

FROM node:20-alpine AS runner
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/memory/package.json ./packages/memory/
COPY packages/core/package.json ./packages/core/
COPY packages/channel-whatsapp/package.json ./packages/channel-whatsapp/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/memory/dist ./packages/memory/dist
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/channel-whatsapp/dist ./packages/channel-whatsapp/dist

CMD ["node", "packages/channel-whatsapp/dist/index.js"]
