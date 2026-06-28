# Data Model — `undrecreaitwins` (Engine)

> **Living spec.** Canonical source: [`packages/core/src/models/`](../../packages/core/src/models) (Drizzle, file-per-table) · aggregator [`index.ts`](../../packages/core/src/models/index.ts). Migrations: [`drizzle/`](../../drizzle) (16 SQL files + `rls/001_enable_rls.sql`). Embeddings via pgvector (`vector` type). Keep this file in lockstep with the schemas.

## 1. Enums (pgEnum)

`validator_mode` ('active'|'dry-run') · `validator_verdict` ('no_op'|'append_disclaimer'|'block'|'rewrite'|'error'|'strip'|'pass') · `feedback_status` ('pending'|'active'|'archived') · `mcp_scope` ('tenant'|'platform') · `mcp_transport` ('http'|'stdio').

Plus text-enum columns (CHECK or app-enforced): see per-table notes.

## 2. Identity & Tenancy

- **`tenants`** ([tenants.ts](../../packages/core/src/models/tenants.ts)) — `id` (text PK), `status` (default 'active'), `createdAt`, **`groundingMode`** text `'vector'|'big-context'` (default 'vector'). Tenant-level grounding default.

## 3. Personas & Conversations

- **`personas`** ([personas.ts](../../packages/core/src/models/personas.ts)) — central table.
  - IDs: `id` (text PK, may be external), `tenantId`, `name`, `slug` (unique per tenant), `systemPrompt`.
  - Config: `traits` (jsonb `PersonaTraits`), `modelPreferences` (jsonb), `version` (bigint optimistic concurrency).
  - Annotations: `annotationSimilarityThreshold` (real, default 0.7), `hasAnnotations` (bool).
  - Agent: `agentEnabled`, `toolAllowlist` (jsonb), `agentConfig` (jsonb).
  - Hybrid Agent Core (017): `fallbackMessages` (jsonb array), `fallbackThresholdMs` (int default 15000, 3000–55000), `strictRag`, `strictRagRefusal`, `ragRelevanceThreshold` (real default 0.3), `ragMode` text `'static'|'tool'` (default 'static').
  - Feedback (019): `feedbackRetrievalEnabled` (bool default true), `feedbackTokenBudget` (int default 500).
  - Funnel: `funnelGeneration` text `'single'|'dual'` (default 'single').
  - Pacing (FR-012): `pacingConfig` jsonb `PacingConfig { baseDelayMs, typingIndicator, randomVariation }`.
  - Big-context (028): `groundingMode` text (override, nullable), `bigContextMaxTokens` (int nullable), `truncationStrategy` text `'silent'|'fallback-vector'` (default 'silent'), `embeddingsStatus` text `'idle'|'processing'|'completed'`.
  - Indexes: uniqueIndex `(tenantId, slug)`, index `(tenantId)`.

- **`conversations`** ([conversations.ts](../../packages/core/src/models/conversations.ts)) — `id` (uuid), `tenantId`, `personaId`, `channelId` (uuid nullable), `externalUserId`, `summary`, `startedAt`, `endedAt`, `messageCount`, `isTestThread` (bool), `source`, `status` (default 'active': 'active'|'closed'|'operator_assigned'), `lastMessageAt`, `tags` (text[]).
  - Reengagement: `needsReengagement` (bool default true), `lastReengagementAt`, `reengagementCount` (int), `optedOut` (bool), `slots` (jsonb).
  - Indexes: `(tenantId, personaId)`, `(tenantId)`, reengagement scan `(tenantId, needsReengagement, lastMessageAt)`.

- **`messages`** ([messages.ts](../../packages/core/src/models/messages.ts)) — `id` (uuid), `conversationId`, `role`, `content`, `metadata` (jsonb `MessageMetadata`), `createdAt`. Index `(conversationId, createdAt)`.

## 4. Grounding / Documents

- **`documents`** ([documents.ts](../../packages/core/src/models/documents.ts)) — `id` (uuid), `tenantId`, `personaId` (FK cascade), `filename`, `mimeType`, `sizeBytes`, `status` `'pending'|'parsing'|'ready'|'failed'`, `error`, `createdAt`. Big-context: **`fullText`** (text nullable), `priority` (int default 0). Index `(tenantId, personaId)`.
- **`document_chunks`** — `id` (uuid), `tenantId`, `documentId` (FK cascade), `personaId`, `chunkIndex` (int), `text`, `embedding` (vector 1024-dim BGE-M3), `createdAt`. Index `(tenantId, personaId)`.
- **`annotations`** ([annotations.ts](../../packages/core/src/models/annotations.ts)) — `id` (uuid), `tenantId`, `personaId` (FK cascade), `originalQuery`, `normalizedQuery`, `badResponse`, `correctedResponse`, `embedding` (vector), `langfuseDatasetItemId` (text), `createdAt`, `updatedAt`. uniqueIndex `(tenantId, personaId, normalizedQuery)`, index `(tenantId, personaId)`.

## 5. Funnel (003, 020, 029)

- **`funnel_definitions`** ([funnels.ts](../../packages/core/src/models/funnels.ts)) — `id` (uuid), `tenantId` (FK), `personaId` (FK), `name`, `deletedAt` (soft delete), `createdAt`, `updatedAt`. uniqueIndex `(tenantId, personaId)` — one funnel per persona.
- **`funnel_versions`** — `id` (uuid), `definitionId` (FK), `versionNumber` (int), `config` (jsonb `FunnelConfig`), `isActive` (bool), `createdAt`. uniqueIndex `(definitionId, versionNumber)`, **partial uniqueIndex** for active version (one active per definition).
- **`funnel_stages`** ([funnel-stages.ts](../../packages/core/src/models/funnel-stages.ts)) — `id`, `funnelVersionId` (FK), `name`, `order` (int), `objective`, `resolutionCriteria` (jsonb), `nextStageId`/`exitStageId` (self-ref), `stuckAction`, `requiredSlots` (jsonb string[]), `requiresConfirmation` (bool), `confirmationPrompt`, `isAnytime` (bool), `anytimeTriggers` (jsonb string[]).
- **`funnel_fragments`** ([funnel-fragments.ts](../../packages/core/src/models/funnel-fragments.ts)) — `id`, `funnelVersionId` (FK), `stageId` (FK), `type` enum `'normal'|'objection'`, `content`, `triggers` (jsonb `TriggerDefinition { phrases, synonyms }`), `scoreWeight` (real default 1.0), `deliveryMode` enum `'verbatim'|'template'|'llm'`, `adaptiveIntro` (bool), `mediaUrl`, `deliveryCondition` (jsonb).
- **`funnel_slots`** ([funnel-slots.ts](../../packages/core/src/models/funnel-slots.ts)) — `id`, `funnelVersionId` (FK), `stageId` (FK nullable), `name`, `description`, `validationRules` (jsonb), `locked` (bool), `enumValues` (jsonb string[]).
- **`conversation_funnel_states`** ([conversation-funnel-states.ts](../../packages/core/src/models/conversation-funnel-states.ts)) — `conversationId` (PK, FK), `funnelVersionId` (FK), `currentStageId` (FK), `consecutiveStuckCount` (int), `capturedSlots` (jsonb `Record<string, CapturedSlot>`), `returnStack` (jsonb string[]), `pendingConfirmation` (uuid), `version` (bigint), `updatedAt`.

## 6. Validators & Quality

- **`validator_configs`** ([validators.ts](../../packages/core/src/models/validators.ts)) — `id`, `tenantId` (FK), `personaId` (FK), `validatorName` (text), `mode` pgEnum `validator_mode` (default 'active'), `config` (jsonb), `version` (int optimistic), `createdAt`, `updatedAt`. uniqueIndex `(tenantId, personaId, validatorName)`.
- **`validator_runs`** — `id`, `tenantId`, `personaId`, `conversationId`, `messageId` (nullable FK), `validatorName`, `verdict` pgEnum `validator_verdict`, `confidence` (double), `matchedPatterns` (jsonb), `originalContent`, `remediatedContent`, `latencyMs` (int), `isDryRun` (bool), `createdAt`. Indexes: `(tenantId, personaId)`, `(conversationId)`, `(tenantId, createdAt)`.

## 7. Feedback Memory (019)

- **`feedback_memories`** ([feedback-memories.ts](../../packages/core/src/models/feedback-memories.ts)) — `id`, `tenantId`, `personaId` (FK cascade), `contextEmbedding` (**vector 1024-dim** explicit), `lesson` (text), `status` pgEnum `feedback_status` (default 'pending'), `operatorRole` (text), `weight` (real default 1.0), `sourceConversationId` (FK → conversations, set null on delete), `createdAt`, `updatedAt`. Index `(tenantId, personaId, status)`.
- **`conversation_feedback_states`** ([conversation-feedback-states.ts](../../packages/core/src/models/conversation-feedback-states.ts)) — `conversationId` (PK, FK cascade), `appliedFeedbackIds` (jsonb string[]), `messageCount` (int), `lastStageLabel` (text), `updatedAt`.

## 8. Tuning (026)

- **`tuning_drafts`** ([tuning.ts](../../packages/core/src/models/tuning.ts)) — `id`, `tenantId`, `personaId` (FK cascade), `method` text `'doc-extraction'|'template-bootstrap'|'interview'|'self-tuner'`, `status` text `'generating'|'ready'|'failed'|'activated'|'superseded'|'rolled-back'` (default 'generating'), `confidence` text `'high'|'medium'|'low'`, `systemPrompt`, `funnelConfig` (jsonb), `validatorToggles` (jsonb), `diffSections` (jsonb), `previousSnapshot` (jsonb), `signals` (jsonb), `error`, `reviewVerdict` `'approved'|'rejected'`, `reviewNotes`, `createdAt`, `updatedAt`, `activatedAt`.
  - **Partial uniqueIndex** `(personaId) WHERE status = 'generating'` — one generating draft at a time.
  - Indexes: `(personaId, status)`, `(tenantId, status)`, `(createdAt DESC)`.

## 9. Agent & Audit

- **`agent_runs`** ([agent-runs.ts](../../packages/core/src/models/agent-runs.ts)) — `id` (text PK), `tenantId`, `personaId`, `conversationId` (nullable), `kind` (default 'agentic'), `status` (default 'running'), `inputPreview`, `outputPreview`, `stepsJson` (jsonb), `usageJson` (jsonb), `loopIterations` (int), `tokensUsed` (int), `errorMessage`, `routingDecision`, `createdAt`, `completedAt`. Indexes: `(tenantId)`, `(personaId)`, `(createdAt)`.
- **`action_audit`** ([action-audit.ts](../../packages/core/src/models/action-audit.ts)) — `id` (text PK), `tenantId`, `personaId`, `toolName`, `argsJson` (text — **redacted**), `resultJson` (text), `idempotencyKey` (text, unique per tenant), `isWriteAction` (bool), `status` text `'pending'|'ok'|'failed'|'abandoned'|'denied'|'dry_run'` (default 'pending'), `errorMessage`, `createdAt`. uniqueConstraint `(tenantId, idempotencyKey)`. Sweep index `(status, createdAt)`.

## 10. MCP Catalog (014)

- **`mcp_catalog_entry`** ([mcp-catalog-entry.ts](../../packages/core/src/models/mcp-catalog-entry.ts)) — `id`, `tenantId`, `scope` pgEnum `mcp_scope` (default 'tenant'), `name`, `transport` pgEnum `mcp_transport` (default 'http'), `url`, `command`, `args` (jsonb), `authCiphertext` (text), `authRef` (text — KMS key ref), `toolsInclude` (jsonb string[]), `toolsExclude` (jsonb string[]), `timeoutMs` (int default 30000), `tlsVerify` (bool default true), `enabled` (bool default true), `createdAt`, `updatedAt`. uniqueIndex `(tenantId, name)`, uniqueIndex `(id, tenantId)`.
- **`assistant_mcp_binding`** — `id`, `tenantId`, `personaId` (FK cascade), `catalogEntryId` (FK cascade), `enabled` (bool), `toolOverrides` (jsonb array `{ name, include?, isWrite?, requiresConfirmation? }`), `createdAt`, `updatedAt`. uniqueIndex `(personaId, catalogEntryId)`.

## 11. Channels / Delivery / Retry

- **`channel_instances`** ([channel-instances.ts](../../packages/core/src/models/channel-instances.ts)) — `id`, `tenantId`, `personaId`, `channelType` (text), `config` (jsonb), `credentialsCiphertext` (text), `kmsKeyRef` (text), `status` (default 'disconnected'), `lastHealthCheckAt`, `createdAt`.
- **`delivery_records`** ([delivery-record.ts](../../packages/core/src/models/delivery-record.ts)) — CAS-ledger (FR-011). `id`, `tenantId`, `conversationId`, `channelMessageId` (text), `state` text `'pending'|'fallback_sent'|'final_delivered'`, `createdAt`, `updatedAt`. uniqueIndex `(tenantId, conversationId, channelMessageId)`.
- **`llm_retry_jobs`** — `id`, `personaId` (FK cascade), `tenantId`, `conversationId`, `channelMessageId`, `messagesPayload` (jsonb — **PII**), `attemptCount` (int), `maxAttempts` (int default 5), `nextRetryAt`, `status` text `'pending'|'in_progress'|'completed'|'dlq'` (default 'pending'), `createdAt`, `updatedAt`. uniqueIndex `(tenantId, conversationId, channelMessageId)`, indexes `(status, nextRetryAt)`, `(personaId)`.

## 12. Re-engagement (009)

- **`followup_rules`** ([followups.ts](../../packages/core/src/models/followups.ts)) — `id`, `tenantId`, `triggerStaleMinutes` (int), `conditions` (jsonb), `backoff` (jsonb number[]), `maxAttempts` (int default 3), `minIntervalMinutes` (int default 1440 = 24h), `template` (text), `isActive` (bool), `createdAt`, `updatedAt`. Index `(tenantId, isActive)`.
- **`followup_attempts`** — `id`, `conversationId` (FK), `ruleId` (FK), `tenantId`, `status` text `'scheduled'|'processing'|'sent'|'failed'|'opted_out'|'expired'`, `scheduledAt`, `sentAt`, `claimedAt`, `failureReason`, `idempotencyKey` (text), `createdAt`, `updatedAt`. uniqueIndex `(idempotencyKey)`, `(tenantId, status, scheduledAt)`, `(tenantId, status, claimedAt)`.

## 13. Auth / Usage / Training / LLM-provider

- **`api_tokens`** ([api-tokens.ts](../../packages/core/src/models/api-tokens.ts)) — `id`, `tenantId`, `name`, `tokenHash` (sha256 hex), `createdAt`, `revokedAt`. Index `(tokenHash)`.
- **`workspaceApiKeys`** (`api_keys`, [api-key.ts](../../packages/core/src/models/api-key.ts)) — workspace-level API keys.
- **`usage_events`** ([usage-events.ts](../../packages/core/src/models/usage-events.ts)) — `id`, `tenantId`, `personaId`, `conversationId`, `provider`, `model`, `inputTokens`, `outputTokens`, `latencyMs`, `createdAt`. Indexes `(tenantId, createdAt)`, `(tenantId, personaId, createdAt)`.
- **`training_jobs`** ([training-jobs.ts](../../packages/core/src/models/training-jobs.ts)) — `id`, `tenantId`, `personaId`, `sourceType` (text: telegram_json, whatsapp_txt, generic_jsonl), `sourceFileRef`, `status`, `progressPercent`, `extractedTraits` (jsonb `PersonaTraits`), `errorMessage`, `startedAt`, `completedAt`, `createdAt`.
- **`llm_provider_config`** + **`tenant_llm_default`** ([llm-provider.ts](../../packages/core/src/models/llm-provider.ts)) — BYOK. Per-persona override + tenant default. Fields: `providerType`, `baseUrl`, `modelId`, `apiKeyCiphertext`, `apiKeyRef` (KMS), `temperature`, `maxTokens`, `enabled`, `version` (optimistic). uniqueIndex per persona / per tenant.

## 14. Cross-Cutting Patterns

- **Tenant isolation**: every table has `tenantId`. **RLS** (`drizzle/rls/001_enable_rls.sql`) enforces `app.current_tenant` server-side; `withTenantContext(tenantId, fn)` sets it.
- **Optimistic concurrency**: `version` (bigint on personas/conversation_funnel_states; int on validator_configs/llm_provider_config) + `If-Match` header support on PATCH.
- **CAS (Compare-And-Swap)**: `delivery_records.state` atomic UPDATE prevents double-delivery.
- **Idempotency keys**: `action_audit(tenantId, idempotencyKey)`, `followup_attempts(idempotencyKey)`, `llm_retry_jobs(tenantId, conversationId, channelMessageId)`.
- **Atomic claim** (no check-then-insert): `followup_attempts` scheduled→processing via `FOR UPDATE SKIP LOCKED`.
- **Vector dim consistency**: `feedback_memories.contextEmbedding` and `document_chunks.embedding` MUST stay 1024 (BGE-M3). Changing requires reindex migration.
- **Soft delete**: `funnel_definitions.deletedAt`, `documents.status='failed'`, `feedback_memories.status='archived'` (never hard-delete memories).
- **Encryption at rest**: `channel_instances.credentialsCiphertext`, `mcp_catalog_entry.authCiphertext`, `llm_provider_config.apiKeyCiphertext` — AES, `*Ref`/`*KeyRef` columns reference KMS keys.
- **PII handling**: `llm_retry_jobs.messagesPayload` contains user content — treat as PII, purge on `completed`.
- **Partial unique indexes** enforce invariants: one active funnel version per definition, one generating tuning draft per persona.
