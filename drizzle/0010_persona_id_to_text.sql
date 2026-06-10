-- 010: Align personas.id + persona_id FK columns from uuid → text
-- Migration 0007 converted tenant_id to text (CUID2) but missed personas.id
-- and all persona_id foreign-key columns in older tables.
-- Newer tables (action_audit, agent_runs, llm_provider_config) already use text.
-- Standing Order #5: reviewed migration, NOT drizzle-kit generated

-- ─── Step 1: Drop FK constraints that reference personas(id) ────────────────

ALTER TABLE "documents"
  DROP CONSTRAINT IF EXISTS "documents_persona_id_personas_id_fk";
--> statement-breakpoint
ALTER TABLE "document_chunks"
  DROP CONSTRAINT IF EXISTS "document_chunks_document_id_documents_id_fk";
--> statement-breakpoint
ALTER TABLE "annotations"
  DROP CONSTRAINT IF EXISTS "annotations_persona_id_personas_id_fk";
--> statement-breakpoint
ALTER TABLE "channel_instances"
  DROP CONSTRAINT IF EXISTS "channel_instances_persona_id_personas_id_fk";
--> statement-breakpoint
ALTER TABLE "conversations"
  DROP CONSTRAINT IF EXISTS "conversations_persona_id_personas_id_fk";
--> statement-breakpoint
ALTER TABLE "funnel_definitions"
  DROP CONSTRAINT IF EXISTS "funnel_definitions_persona_id_personas_id_fk";
--> statement-breakpoint
ALTER TABLE "validator_configs"
  DROP CONSTRAINT IF EXISTS "validator_configs_persona_id_personas_id_fk";
--> statement-breakpoint
ALTER TABLE "validator_runs"
  DROP CONSTRAINT IF EXISTS "validator_runs_persona_id_personas_id_fk";
--> statement-breakpoint
ALTER TABLE "assistant_mcp_binding"
  DROP CONSTRAINT IF EXISTS "assistant_mcp_binding_persona_id_personas_id_fk";
--> statement-breakpoint

-- ─── Step 2: personas.id uuid → text ────────────────────────────────────────

ALTER TABLE "personas"
  ALTER COLUMN "id" SET DATA TYPE text,
  ALTER COLUMN "id" DROP DEFAULT;
--> statement-breakpoint

-- ─── Step 3: All persona_id columns uuid → text ────────────────────────────

ALTER TABLE "documents"
  ALTER COLUMN "persona_id" SET DATA TYPE text;
--> statement-breakpoint
ALTER TABLE "document_chunks"
  ALTER COLUMN "persona_id" SET DATA TYPE text;
--> statement-breakpoint
ALTER TABLE "annotations"
  ALTER COLUMN "persona_id" SET DATA TYPE text;
--> statement-breakpoint
ALTER TABLE "channel_instances"
  ALTER COLUMN "persona_id" SET DATA TYPE text;
--> statement-breakpoint
ALTER TABLE "conversations"
  ALTER COLUMN "persona_id" SET DATA TYPE text;
--> statement-breakpoint
ALTER TABLE "funnel_definitions"
  ALTER COLUMN "persona_id" SET DATA TYPE text;
--> statement-breakpoint
ALTER TABLE "training_jobs"
  ALTER COLUMN "persona_id" SET DATA TYPE text;
--> statement-breakpoint
ALTER TABLE "usage_events"
  ALTER COLUMN "persona_id" SET DATA TYPE text;
--> statement-breakpoint
ALTER TABLE "validator_configs"
  ALTER COLUMN "persona_id" SET DATA TYPE text;
--> statement-breakpoint
ALTER TABLE "validator_runs"
  ALTER COLUMN "persona_id" SET DATA TYPE text;
--> statement-breakpoint
ALTER TABLE "assistant_mcp_binding"
  ALTER COLUMN "persona_id" SET DATA TYPE text;
--> statement-breakpoint

-- ─── Step 4: Recreate FK constraints ────────────────────────────────────────

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_persona_id_personas_id_fk"
  FOREIGN KEY ("persona_id") REFERENCES "personas"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "annotations"
  ADD CONSTRAINT "annotations_persona_id_personas_id_fk"
  FOREIGN KEY ("persona_id") REFERENCES "personas"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_instances"
  ADD CONSTRAINT "channel_instances_persona_id_personas_id_fk"
  FOREIGN KEY ("persona_id") REFERENCES "personas"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_persona_id_personas_id_fk"
  FOREIGN KEY ("persona_id") REFERENCES "personas"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "funnel_definitions"
  ADD CONSTRAINT "funnel_definitions_persona_id_personas_id_fk"
  FOREIGN KEY ("persona_id") REFERENCES "personas"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "validator_configs"
  ADD CONSTRAINT "validator_configs_persona_id_personas_id_fk"
  FOREIGN KEY ("persona_id") REFERENCES "personas"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "validator_runs"
  ADD CONSTRAINT "validator_runs_persona_id_personas_id_fk"
  FOREIGN KEY ("persona_id") REFERENCES "personas"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assistant_mcp_binding"
  ADD CONSTRAINT "assistant_mcp_binding_persona_id_personas_id_fk"
  FOREIGN KEY ("persona_id") REFERENCES "personas"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- document_chunks references documents(id), not personas(id) — recreate too
-- since documents.id stays uuid, this FK is fine; but we dropped it above
-- because the intermediate step changed types that could cascade.
-- Actually documents.id stays uuid, so document_chunks.document_id stays uuid.
-- Re-add only if we actually dropped it:
-- (We only dropped it for safety during the persona_id alter on document_chunks)
ALTER TABLE "document_chunks"
  ADD CONSTRAINT "document_chunks_document_id_documents_id_fk"
  FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE cascade ON UPDATE no action;
