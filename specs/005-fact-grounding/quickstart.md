# Fact Grounding Quickstart

This guide explains how to use the `IGroundingEngine` service.

## Initialization

The Grounding Engine is injected as part of the core engine services. It relies on the shared `embedding-service` and PostgreSQL (`pgvector`).

## Ingesting a Document

To ingest a document (PDF, DOCX, TXT):

```typescript
import fs from 'fs/promises';

const docBuffer = await fs.readFile('./company_policies.pdf');
const meta = {
  filename: 'company_policies.pdf',
  mimeType: 'application/pdf',
  sizeBytes: docBuffer.byteLength
};

await engine.grounding.ingest(docBuffer, meta);
```

## Querying Context

To retrieve factual context for a user prompt:

```typescript
const context = await engine.grounding.query("What is our refund policy?", twinId);

if (context.length > 0) {
  // Inject context into the LLM prompt
  const contextStr = context.map(c => c.text).join('\n\n');
  // ...
}
```
