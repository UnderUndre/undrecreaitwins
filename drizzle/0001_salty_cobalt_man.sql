CREATE TYPE "public"."feedback_status" AS ENUM('pending', 'active', 'archived');--> statement-breakpoint
ALTER TYPE "public"."validator_verdict" ADD VALUE 'strip';--> statement-breakpoint
ALTER TYPE "public"."validator_verdict" ADD VALUE 'pass';--> statement-breakpoint
CREATE TABLE "conversation_feedback_states" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"applied_feedback_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"last_stage_label" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"channel_message_id" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"persona_id" text NOT NULL,
	"context_embedding" vector(1024) NOT NULL,
	"lesson" text NOT NULL,
	"status" "feedback_status" DEFAULT 'pending' NOT NULL,
	"operator_role" text,
	"weight" real DEFAULT 1,
	"source_conversation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_retry_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"persona_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"channel_message_id" text NOT NULL,
	"messages_payload" jsonb NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "fallback_messages" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "fallback_threshold_ms" integer DEFAULT 15000 NOT NULL;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "strict_rag" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "strict_rag_refusal" text;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "rag_relevance_threshold" real DEFAULT 0.3 NOT NULL;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "rag_mode" text DEFAULT 'static' NOT NULL;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "feedback_retrieval_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "feedback_token_budget" integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "funnel_generation" text DEFAULT 'single' NOT NULL;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "pacing_config" jsonb DEFAULT '{"baseDelayMs":0,"typingIndicator":false,"randomVariation":false}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_feedback_states" ADD CONSTRAINT "conversation_feedback_states_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_memories" ADD CONSTRAINT "feedback_memories_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_memories" ADD CONSTRAINT "feedback_memories_source_conversation_id_conversations_id_fk" FOREIGN KEY ("source_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_retry_jobs" ADD CONSTRAINT "llm_retry_jobs_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_records_msg_uq" ON "delivery_records" USING btree ("tenant_id","conversation_id","channel_message_id");--> statement-breakpoint
CREATE INDEX "feedback_memories_tenant_persona_status_idx" ON "feedback_memories" USING btree ("tenant_id","persona_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_retry_jobs_msg_uq" ON "llm_retry_jobs" USING btree ("tenant_id","conversation_id","channel_message_id");--> statement-breakpoint
CREATE INDEX "llm_retry_jobs_status_next_retry_idx" ON "llm_retry_jobs" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE INDEX "llm_retry_jobs_persona_idx" ON "llm_retry_jobs" USING btree ("persona_id");