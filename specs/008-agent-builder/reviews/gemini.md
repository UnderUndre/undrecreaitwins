# SpecKit Review: 008-agent-builder

**Reviewer**: gemini
**Reviewed at**: 2026-05-31T00:00:00Z
**Commit**: HEAD
**Artifacts reviewed**: spec.md, plan.md, tasks.md, data-model.md

## Summary

The architecture effectively isolates the annotation feedback loop from the legacy monolith by embracing pgvector and Langfuse, correctly focusing on the moat (inference injection) while offloading the commodity (analytics) to Langfuse. However, the synchronous integration of the TEI embedding sidecar into the critical reply path introduces a severe single point of failure and unnecessary performance overhead. Additionally, the plan overlooks Node.js event loop starvation risks during document parsing.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | CRITICAL | Failure Modes | **Chat Downtime on TEI Failure**: T012 specifies embedding the incoming query to retrieve annotations before generation. If the TEI sidecar is down, unreachable, or timing out, the embedding call fails. The plan lacks a fallback. A hard failure here would completely break the core chat functionality just because the few-shot search failed. | Implement a fallback in `chat-service.ts`: wrap the embedding and retrieval step in a try-catch with a strict timeout (e.g., 500ms). On error, log the failure and proceed with generation *without* few-shot injection. The core chat must survive a TEI outage. |
| F2 | HIGH | Performance & Scale | **Unnecessary Embeddings on Every Chat**: The system embeds *every* incoming query (T012) to search for annotations. For new assistants or those without any feedback loop corrections, this introduces 50-100ms of latency and unnecessary GPU/CPU load on the TEI sidecar for zero benefit. | Add a lightweight pre-check in `chat-service.ts`: perform a fast `COUNT(*)` on the `annotations` table for the given `personaId`. Only call the embedding service if `count > 0`. |
| F3 | HIGH | Edge Case / Performance | **Event Loop Starvation during Parsing**: T020 uses `officeParser` and recursive chunking in a BullMQ worker. If the worker runs in the same Node.js process as the Fastify API server, parsing a 10MB PDF or DOCX file synchronously will block the main event loop, causing health check failures, dropped API requests, and high latency. | Explicitly specify that the BullMQ worker MUST run as a Sandboxed Process (separate Node process) or use worker threads for the `officeParser` and chunking execution to protect the API event loop. |
| F4 | HIGH | Security / Integration | **Fastify Payload Limits & OOM Risk**: T019 specifies a ≤10MB document upload limit. Fastify's default `bodyLimit` is 1MB, which will cause pre-handler 413 Payload Too Large errors. Furthermore, parsing 10 concurrent 10MB files in memory risks OOM. | Explicitly update Fastify route configuration to increase `bodyLimit` to 10MB for the `/documents` endpoint. Specify whether files are streamed to disk (using `fastify-multipart`) or buffered in memory, and enforce concurrency limits. |
| F5 | MEDIUM | Failure Modes | **Unhandled Rejections in Fire-and-Forget**: T016 specifies "fire-and-forget" for Langfuse trace emission. If implemented natively without a `.catch()` handler, network timeouts to Langfuse will result in `UnhandledPromiseRejection` errors, which crash modern Node.js processes. | Ensure the fire-and-forget implementation catches and suppresses all network errors internally (e.g., `langfuseService.emit(...).catch(err => logger.warn(...))`). |
| F6 | MEDIUM | Edge Case | **Orphaned BullMQ Jobs vs CASCADE Delete**: If a document or persona is deleted via the API while its async parsing job (T020) is queued or running, the worker will attempt to insert into `document_chunks`. Due to `CASCADE` deletes, this will throw a Postgres foreign key violation and fail the job. | The BullMQ worker should catch `ForeignKeyViolation` errors (Postgres code `23503`) specifically, treating them as graceful aborts rather than job failures, avoiding unnecessary retries and alert noise. |

## Alternative approaches considered

- **Pre-flight Embedding Cache**: Instead of checking `COUNT(*)` per message, the assistant's `personas` record could include a boolean `hasAnnotations` flag that is toggled to `true` on the first upsert, completely avoiding the DB check on the hot path.
- **Asynchronous Few-Shot Generation**: Rather than blocking the reply path to embed and retrieve annotations, the system could stream the standard reply while simultaneously querying annotations. If an annotation matches *during* the generation, the UI could surface it as a "Correction suggested" chip. However, injecting it pre-generation (as planned) is architecturally simpler and ensures the LLM's primary answer is correct, provided the TEI fallback (F1) is implemented.

## VERDICT

```yaml
verdict: CRITICAL
reviewer: gemini
reviewed_at: 2026-05-31T00:00:00Z
commit: HEAD
critical_count: 1
high_count: 3
medium_count: 2
low_count: 0
```
