CREATE TABLE "annotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"original_query" text NOT NULL,
	"normalized_query" text NOT NULL,
	"bad_response" text NOT NULL,
	"corrected_response" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"langfuse_dataset_item_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "followup_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"failure_reason" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "followup_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trigger_stale_minutes" integer NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"backoff" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"min_interval_minutes" integer DEFAULT 1440 NOT NULL,
	"template" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "is_test_thread" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_message_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "tags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "needs_reengagement" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_reengagement_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "reengagement_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "opted_out" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "annotation_similarity_threshold" real DEFAULT 0.7 NOT NULL;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "has_annotations" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followup_attempts" ADD CONSTRAINT "followup_attempts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followup_attempts" ADD CONSTRAINT "followup_attempts_rule_id_followup_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."followup_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "annotations_tenant_persona_query_idx" ON "annotations" USING btree ("tenant_id","persona_id","normalized_query");--> statement-breakpoint
CREATE INDEX "annotations_tenant_persona_idx" ON "annotations" USING btree ("tenant_id","persona_id");--> statement-breakpoint
CREATE INDEX "document_chunks_tenant_persona_idx" ON "document_chunks" USING btree ("tenant_id","persona_id");--> statement-breakpoint
CREATE INDEX "documents_tenant_persona_idx" ON "documents" USING btree ("tenant_id","persona_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_followup_attempts_idempotency" ON "followup_attempts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_followup_attempts_tenant_status_scheduled" ON "followup_attempts" USING btree ("tenant_id","status","scheduled_at");--> statement-breakpoint
CREATE INDEX "idx_followup_attempts_tenant_status_claimed" ON "followup_attempts" USING btree ("tenant_id","status","claimed_at");--> statement-breakpoint
CREATE INDEX "idx_followup_rules_tenant_active" ON "followup_rules" USING btree ("tenant_id","is_active");--> statement-breakpoint
CREATE INDEX "idx_conversations_reengagement_scan" ON "conversations" USING btree ("tenant_id","needs_reengagement","last_message_at");