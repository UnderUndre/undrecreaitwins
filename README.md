# undrecreaitwins
Opensource AI-clone backend

## Background Workers
- **Document Worker**: Processes document ingestion and embeddings.
- **Re-engagement Worker**: Scans dormant conversations and sends AI-generated win-back messages.
  - Run with: `npm run worker:reengagement` (ensure `TWIN_REENGAGE_WORKERS` and `REDIS_URL` are set).

## Development
```bash
npm install
npm run dev
```

## Testing
```bash
npm test
```
