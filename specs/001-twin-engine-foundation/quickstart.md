# Quickstart — undrecreaitwins Twin Engine

Three paths. Pick one.

---

## Standalone Path (no orchestra)

Runs twin-engine API + Postgres + Redis locally. LLM calls go direct to provider.

### 1. Clone repo

```bash
git clone https://github.com/undrecreaitwins/twin-engine.git
cd twin-engine
```

### 2. Environment

```bash
cp .env.example .env
```

Edit `.env` — fill in at minimum:

```env
DATABASE_URL=postgresql://undre:undre@localhost:5432/twinengine
REDIS_URL=redis://localhost:6379
LLM_PROVIDER_API_KEY=sk-...
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o
```

### 3. Start stack

```bash
docker compose -f infra/docker-compose.standalone.yml up -d
```

This starts:
- `twin-engine-api` on port **8090**
- `postgres` on port **5432**
- `redis` on port **6379**

### 4. Wait for health

```bash
curl http://localhost:8090/v1/health
```

Expected: `{"status":"ok","version":"0.1.0"}`

### 5. Seed a tenant

```bash
TENANT_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
psql "$DATABASE_URL" -c "INSERT INTO tenants (id) VALUES ('$TENANT_ID');"
echo "Tenant ID: $TENANT_ID"
```

### 6. Create a persona

```bash
curl -X POST http://localhost:8090/v1/personas \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Bot",
    "slug": "test-bot",
    "system_prompt": "You are a helpful assistant."
  }'
```

### 8. Chat

```bash
curl -X POST http://localhost:8090/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "test-bot",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

For streaming:

```bash
curl -N -X POST http://localhost:8090/v1/chat/completions \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "test-bot",
    "stream": true,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

---

## With-Orchestra Path

Connects twin-engine to an existing **undrestrator orchestra** deployment.

### 1. Prerequisites

The undrestrator orchestra must be running.

### 2. Environment

```bash
cp .env.example .env
```

Edit `.env` — set orchestra service URLs:

```env
DATABASE_URL=postgresql://undre:undre@localhost:5432/twinengine
ORCHESTRA_OMNIROUTE_URL=http://localhost:8100/v1
ORCHESTRA_QDRANT_URL=http://localhost:6333
ORCHESTRA_REDIS_URL=redis://localhost:6379
LLM_ROUTING=omniroute
```

### 3. Start stack

```bash
docker compose -f infra/docker-compose.with-orchestra.yml up -d
```

### 4. Verify + seed + chat

Same as standalone steps 4–7. API is identical — routing happens transparently.

---

## First Telegram Channel

Connect your persona to a Telegram bot. Works with either path.

### 1. Get a Telegram bot token

1. Open Telegram, search for **@BotFather**
2. Send `/newbot`
3. Follow prompts
4. Save the token

### 2. Create a channel in the API

```bash
curl -X POST http://localhost:8090/v1/channels \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-ID: $TENANT_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "persona_id": "<persona_id>",
    "channel_type": "telegram",
    "config": {"bot_token": "<YOUR_BOT_TOKEN>"}
  }'
```

### 3. Start the Telegram adapter

```bash
npx @undrecreaitwins/channel-telegram \
  --channel-id=<channel_id> \
  --api-url=http://localhost:8090
```

### 4. Send a message

Open Telegram → find your bot → send `/start` → bot responds with persona's greeting.

---

## Troubleshooting

### Port 8090 already in use

```bash
lsof -i :8090        # macOS/Linux
netstat -ano | grep 8090   # Windows
TWIN_ENGINE_PORT=9090 docker compose -f infra/docker-compose.standalone.yml up -d
```

### Health endpoint returns 502

Wait 10–15 seconds and retry. Check API logs:
```bash
docker compose -f infra/docker-compose.standalone.yml logs api
```

### Telegram adapter not responding

```bash
curl "https://api.telegram.org/bot<YOUR_TOKEN>/getMe"
```
Should return `{"ok":true,"result":{...}}`
