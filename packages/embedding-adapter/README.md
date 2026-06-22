# Embedding Adapter (TEI-to-Cloud Proxy)

A lightweight TypeScript/Fastify proxy service that replaces local HuggingFace TEI Docker containers (`tei-embed`, `tei-rerank`), saving ~4GB RAM by routing embedding and reranking requests to cloud providers (OpenAI, Jina, Cohere).

Matches the HuggingFace TEI HTTP contract exactly.

## Prerequisites

- Node.js >= 20
- pnpm

## Environment Variables

| Env | Default | Description |
|-----|---------|-------------|
| `PORT` | `8095` | HTTP server port |
| `HOST` | `0.0.0.0` | Bind address |
| `EMBEDDING_PROVIDER` | `jina` | `openai` or `jina` |
| `EMBEDDING_MODEL` | (per provider) | Model ID override |
| `RERANK_PROVIDER` | `jina` | `cohere` or `jina` |
| `RERANK_MODEL` | (per provider) | Model ID override |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Custom OpenAI compatible endpoint URL |
| `COHERE_API_KEY` | — | Cohere API key |
| `JINA_API_KEY` | — | Jina API key |
| `UPSTREAM_TIMEOUT_MS` | `10000` | Upstream request timeout (ms) |
| `MAX_CONCURRENT_REQUESTS` | `50` | Max concurrent upstream requests |
| `CIRCUIT_FAILURE_THRESHOLD` | `5` | Consecutive failures before circuit opens |
| `CIRCUIT_RESET_TIMEOUT` | `30` | Seconds before circuit half-open probe |
| `MAX_INPUT_CHARS` | `8192` | Max characters per string in input |
| `BODY_LIMIT` | `9000000` | Fastify body size limit (bytes) |
| `LOG_LEVEL` | `info` | Pino log level |

## Commands

```bash
# Install dependencies
pnpm install

# Run type checker validation
pnpm run validate

# Run tests
pnpm run test

# Run build
pnpm run build

# Start local server (dev mode)
pnpm run dev
```

## Security & Privacy Note

- **Plain HTTP**: The adapter listens on plain HTTP. Deploy ONLY inside a trusted network (Docker internal network or VPN).
- **PII / Key Redaction**: Fastify/Pino is configured to automatically redact `Authorization` headers, provider API keys, and document contents from all logs.

## Docker Compose Integration

The adapter is integrated into `infra/docker-compose.standalone.yml`.

By default, running `docker compose up -d` starts the lightweight `embedding-adapter` service (consuming <100MB RAM) which proxies to cloud APIs.

### Offline Mode (Local Models)

If you want to run completely offline with local models:
1. Run the local HuggingFace TEI containers by enabling the `local-tei` profile:
   ```bash
   docker compose -f infra/docker-compose.standalone.yml --profile local-tei up -d
   ```
2. Configure your environment variables to point directly to these local containers:
   ```env
   EMBEDDINGS_URL=http://tei-embed:80
   RERANK_URL=http://tei-rerank:80
   ```
