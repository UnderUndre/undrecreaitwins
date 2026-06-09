# Multi-Channel Gateway — Deploy Runbook

## Architecture

Each channel adapter runs as a **separate process** (Docker container), communicating
with the twin-engine via Redis Streams (`twin.stream.in` / `twin.stream.out`).

```
                    ┌──────────────────┐
                    │   Twin Engine     │
                    │   (API + Core)    │
                    └────────┬─────────┘
                             │ Redis Streams
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────┴──┐  ┌───────┴───┐  ┌──────┴────┐
     │ Discord   │  │  Matrix   │  │   SMS     │
     │ Adapter   │  │  Adapter  │  │  Adapter  │
     └───────────┘  └───────────┘  └───────────┘
```

## Prerequisites

- Docker + Docker Compose v2
- Redis 7+ (included in compose)
- PostgreSQL (for channel_instances table)
- Network access to platform APIs (Discord, Matrix, Twilio, etc.)

## Directory Structure

```
deploy/channels/
├── docker-compose.channels.yml   # Service definitions
├── README.md                     # This file
└── secrets/                      # Per-adapter credential files (git-ignored)
    ├── channel-discord.env
    ├── channel-matrix.env
    ├── channel-sms.env
    └── ...
```

## Quick Start

### 1. Create secret files

Each adapter needs a `.env` file in `secrets/` with its credentials:

```bash
mkdir -p secrets
```

Example `secrets/channel-discord.env`:
```env
CHANNEL_ID=<uuid>
TENANT_ID=<uuid>
PERSONA_SLUG=<slug>
CREDENTIALS={"botToken":"your-bot-token-here"}
```

Example `secrets/channel-matrix.env`:
```env
CHANNEL_ID=<uuid>
TENANT_ID=<uuid>
PERSONA_SLUG=<slug>
CREDENTIALS={"homeserverUrl":"https://matrix.org","accessToken":"syt_...","userId":"@bot:matrix.org"}
```

Example `secrets/channel-sms.env`:
```env
CHANNEL_ID=<uuid>
TENANT_ID=<uuid>
PERSONA_SLUG=<slug>
CREDENTIALS={"accountSid":"AC...","authToken":"...","fromNumber":"+1234567890"}
```

Example `secrets/channel-webhooks.env`:
```env
CHANNEL_ID=<uuid>
TENANT_ID=<uuid>
PERSONA_SLUG=<slug>
CREDENTIALS={"webhookSecret":"your-secret-key","outgoingUrl":"https://example.com/webhook"}
```

Example `secrets/channel-homeassistant.env`:
```env
CHANNEL_ID=<uuid>
TENANT_ID=<uuid>
PERSONA_SLUG=<slug>
CREDENTIALS={"hassUrl":"http://homeassistant.local:8123","accessToken":"eyJ..."}
```

Example `secrets/channel-email.env`:
```env
CHANNEL_ID=<uuid>
TENANT_ID=<uuid>
PERSONA_SLUG=<slug>
CREDENTIALS={"imapHost":"imap.gmail.com","imapPort":993,"imapUser":"bot@example.com","imapPass":"...","smtpHost":"smtp.gmail.com","smtpPort":587,"smtpUser":"bot@example.com","smtpPass":"..."}
```

### 2. Build adapter images

Each channel package needs a Dockerfile. Template:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY dist/ dist/
CMD ["node", "dist/index.js"]
```

Build from monorepo root:
```bash
# Build all channel packages first
pnpm -r --filter './packages/channel-*' build

# Then build Docker images
docker compose -f deploy/channels/docker-compose.channels.yml build
```

### 3. Start services

```bash
# Start all channels
docker compose -f deploy/channels/docker-compose.channels.yml up -d

# Start specific channel only
docker compose -f deploy/channels/docker-compose.channels.yml up -d channel-discord

# View logs
docker compose -f deploy/channels/docker-compose.channels.yml logs -f channel-matrix
```

## Provisioning a New Channel

1. Create the channel instance in the twin-engine API:
   ```bash
   curl -X POST http://localhost:8090/v1/channels \
     -H "Authorization: Bearer <token>" \
     -H "X-Tenant-Id: <tenant-id>" \
     -H "Content-Type: application/json" \
     -d '{
       "persona_id": "<persona-uuid>",
       "channel_type": "matrix",
       "config": {}
     }'
   ```
   This encrypts credentials via KmsProvider and stores them in `channel_instances.credentialsCiphertext`.

2. Create the corresponding secret file in `deploy/channels/secrets/`.

3. Start the adapter container.

## Scaling

Each adapter is a standalone consumer process. Scale per-channel:

```bash
# Scale SMS adapter to handle more throughput
docker compose -f deploy/channels/docker-compose.channels.yml up -d --scale channel-sms=3
```

Multiple instances of the same adapter share the same Redis consumer group,
so messages are distributed across them (no duplication).

## Health Monitoring

```bash
# Check all channel health
curl -H "Authorization: Bearer <token>" \
     -H "X-Tenant-Id: <tenant-id>" \
     http://localhost:8090/v1/channels/health
```

Response:
```json
{
  "channels": {
    "ch-uuid-1": { "status": "active", "uptimeSeconds": 3600 },
    "ch-uuid-2": { "status": "error", "error": "Connection refused" }
  },
  "overall": "degraded"
}
```

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Adapter exits immediately | Check logs: `docker compose logs channel-X` |
| No inbound messages | Verify Redis connectivity + platform credentials |
| Duplicate outbound | Check consumer group: `redis-cli XINFO GROUPS twin.stream.out` |
| Messages stuck in XPENDING | `redis-cli XPENDING twin.stream.out <group>` — check idle time |
| Adapter status 'error' | Health endpoint; check platform API status |

## Credential Rotation

Use the `rotateChannelCredentials` flow (T030):
1. Re-encrypt with new KMS key
2. Update `channel_instances.kmsKeyRef`
3. Signal adapter to disconnect/reconnect
4. New connections use new secret; old drain naturally

Zero downtime.
