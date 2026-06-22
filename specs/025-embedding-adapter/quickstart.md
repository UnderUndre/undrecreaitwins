# Quickstart: Embedding Adapter

> **⚠️ Privacy Warning**: This adapter transmits document content (`inputs` for `/embed`, `documents` for `/rerank`) to a third-party cloud provider. TEI kept all data local. Ensure compliance with your data-handling policy before deploying with sensitive content (PII, proprietary code, internal documents). See `spec.md §1.1 Tradeoffs` for the full trade-off matrix.

> **🔒 Network Security**: The adapter listens on plain HTTP. Deploy ONLY inside a trusted network (Docker internal network or VPN). TLS termination is the responsibility of a reverse proxy or container orchestration layer.

## Local Development

```bash
# 1. From monorepo root or packages/embedding-adapter/
cd packages/embedding-adapter

# 2. Install deps
pnpm install

# 3. Set env
export JINA_API_KEY=jina_xxx
# or: export OPENAI_API_KEY=sk-xxx / export COHERE_API_KEY=xxx

# 4. Start dev server (hot reload via tsx watch)
pnpm dev:embedding-adapter
```

## Testing

```bash
# Unit + integration tests
pnpm test:embedding-adapter

# Manual smoke test
curl http://localhost:8095/health
# → {"status":"ok","provider":"jina"}

curl -X POST http://localhost:8095/embed \
  -H "Content-Type: application/json" \
  -d '{"inputs": "test string"}'
# → [0.0123, -0.0456, ...]

curl -X POST http://localhost:8095/rerank \
  -H "Content-Type: application/json" \
  -d '{"query": "test", "documents": ["doc a", "doc b"]}'
# → [{"index":0,"score":0.95},{"index":1,"score":0.13}]
```

## Docker Compose Integration

### 1. Add to `docker-compose.standalone.yml`

```yaml
services:
  embedding-adapter:
    build:
      context: ./packages/embedding-adapter
    expose:
      - "8095"                    # NOT ports: — don't publish on host (review-fix S2)
    environment:
      EMBEDDING_PROVIDER: jina
      RERANK_PROVIDER: jina
      JINA_API_KEY: ${JINA_API_KEY}
      PORT: 8095
    healthcheck:
      test: ["CMD", "wget", "-q", "-O-", "http://localhost:8095/health"]   # wget, not curl (review-fix A3 — Alpine)
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 5s
    restart: unless-stopped
```

### 2. local-tei Profile (Optional Offline Mode)

The original local HuggingFace TEI containers (`tei-embed` and `tei-rerank`) are kept in `docker-compose.standalone.yml` under the `local-tei` profile. This saves ~4GB RAM by default. 

To run completely offline with local models:
1. Start compose with the `local-tei` profile:
   ```bash
   docker compose -f infra/docker-compose.standalone.yml --profile local-tei up -d
   ```
2. Update engine environment to point directly to the local containers:
   ```yaml
   EMBEDDINGS_URL=http://tei-embed:80
   RERANK_URL=http://tei-rerank:80
   ```

Otherwise, leave the profile disabled, and the engine will connect to `embedding-adapter:8095` to use cloud APIs.

### 3. Update engine environment (Default Cloud Proxy Mode)

```yaml
# Before:
EMBEDDINGS_URL=http://tei-embed:8080

# After:
EMBEDDINGS_URL=http://embedding-adapter:8095
```

## Provider Configuration

### Jina (Default — Recommended)

```bash
JINA_API_KEY=jina_xxx            # Required
EMBEDDING_PROVIDER=jina           # Default
EMBEDDING_MODEL=jina-embeddings-v3  # Default, 1024-dim
RERANK_PROVIDER=jina              # Default
RERANK_MODEL=jina-reranker-v2-base-multilingual  # Default
```

### OpenAI (Embeddings Only)

```bash
OPENAI_API_KEY=sk-xxx             # Required
EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=text-embedding-3-small  # Default, 1536-dim ⚠️ needs re-index
RERANK_PROVIDER=jina               # OpenAI has no rerank
JINA_API_KEY=jina_xxx              # Needed for reranking
```

### Cohere (Rerank Only)

```bash
COHERE_API_KEY=xxx                 # Required
EMBEDDING_PROVIDER=jina            # Cohere has no OpenAI-compatible embed
JINA_API_KEY=jina_xxx              # Needed for embeddings
RERANK_PROVIDER=cohere
RERANK_MODEL=rerank-multilingual-v3.0  # Default
```

## Config Reference

| Env | Default | Description |
|-----|---------|-------------|
| `PORT` | `8095` | HTTP server port |
| `HOST` | `0.0.0.0` | Bind address |
| `EMBEDDING_PROVIDER` | `jina` | `openai` or `jina` |
| `EMBEDDING_MODEL` | (per provider) | Model ID override |
| `RERANK_PROVIDER` | `jina` | `cohere` or `jina` |
| `RERANK_MODEL` | (per provider) | Model ID override |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Custom OpenAI compatible base URL |
| `COHERE_API_KEY` | — | Cohere API key |
| `JINA_API_KEY` | — | Jina API key |
| `UPSTREAM_TIMEOUT_MS` | `10000` | Upstream request timeout (reduced from 30000 per review — protects chat-path latency) |
| `MAX_CONCURRENT_REQUESTS` | `50` | Max concurrent in-flight upstream requests (review-fix) |
| `CIRCUIT_FAILURE_THRESHOLD` | `5` | Consecutive failures before circuit opens (review-fix) |
| `CIRCUIT_RESET_TIMEOUT` | `30` | Seconds before circuit half-open probe (review-fix) |
| `MAX_INPUT_CHARS` | `8192` | Max chars per string in `/embed` input (review-fix) |
| `BODY_LIMIT` | `1048576` | Fastify body size limit in bytes (review-fix) |
| `LOG_LEVEL` | `info` | Pino log level |
