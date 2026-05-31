CREATE TYPE "public"."fragment_type" AS ENUM('normal', 'objection');--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "channel_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"channel_type" text NOT NULL,
	"config" jsonb NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"last_health_check_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_funnel_states" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"funnel_version_id" uuid NOT NULL,
	"current_stage_id" uuid NOT NULL,
	"consecutive_stuck_count" integer DEFAULT 0 NOT NULL,
	"captured_slots" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"channel_id" uuid,
	"external_user_id" text NOT NULL,
	"summary" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"message_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funnel_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"name" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funnel_fragments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"funnel_version_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"type" "fragment_type" DEFAULT 'normal' NOT NULL,
	"content" text NOT NULL,
	"triggers" jsonb NOT NULL,
	"score_weight" real DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funnel_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"funnel_version_id" uuid NOT NULL,
	"stage_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"validation_rules" jsonb
);
--> statement-breakpoint
CREATE TABLE "funnel_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"funnel_version_id" uuid NOT NULL,
	"name" text NOT NULL,
	"order" integer NOT NULL,
	"objective" text,
	"resolution_criteria" jsonb NOT NULL,
	"next_stage_id" uuid,
	"stuck_action" text,
	"exit_stage_id" uuid
);
--> statement-breakpoint
CREATE TABLE "funnel_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"definition_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"config" jsonb NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"system_prompt" text NOT NULL,
	"traits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"model_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_file_ref" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"progress_percent" integer DEFAULT 0 NOT NULL,
	"extracted_traits" jsonb,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_funnel_states" ADD CONSTRAINT "conversation_funnel_states_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_funnel_states" ADD CONSTRAINT "conversation_funnel_states_funnel_version_id_funnel_versions_id_fk" FOREIGN KEY ("funnel_version_id") REFERENCES "public"."funnel_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_funnel_states" ADD CONSTRAINT "conversation_funnel_states_current_stage_id_funnel_stages_id_fk" FOREIGN KEY ("current_stage_id") REFERENCES "public"."funnel_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_definitions" ADD CONSTRAINT "funnel_definitions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_definitions" ADD CONSTRAINT "funnel_definitions_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_fragments" ADD CONSTRAINT "funnel_fragments_funnel_version_id_funnel_versions_id_fk" FOREIGN KEY ("funnel_version_id") REFERENCES "public"."funnel_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_fragments" ADD CONSTRAINT "funnel_fragments_stage_id_funnel_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."funnel_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_slots" ADD CONSTRAINT "funnel_slots_funnel_version_id_funnel_versions_id_fk" FOREIGN KEY ("funnel_version_id") REFERENCES "public"."funnel_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_slots" ADD CONSTRAINT "funnel_slots_stage_id_funnel_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."funnel_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_stages" ADD CONSTRAINT "funnel_stages_funnel_version_id_funnel_versions_id_fk" FOREIGN KEY ("funnel_version_id") REFERENCES "public"."funnel_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_stages" ADD CONSTRAINT "funnel_stages_next_stage_id_funnel_stages_id_fk" FOREIGN KEY ("next_stage_id") REFERENCES "public"."funnel_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_stages" ADD CONSTRAINT "funnel_stages_exit_stage_id_funnel_stages_id_fk" FOREIGN KEY ("exit_stage_id") REFERENCES "public"."funnel_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnel_versions" ADD CONSTRAINT "funnel_versions_definition_id_funnel_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."funnel_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_api_tokens_token_hash" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_channels_tenant" ON "channel_instances" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_channels_tenant_persona" ON "channel_instances" USING btree ("tenant_id","persona_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_tenant_persona" ON "conversations" USING btree ("tenant_id","persona_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_tenant" ON "conversations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "funnel_defs_tenant_idx" ON "funnel_definitions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "funnel_defs_persona_idx" ON "funnel_definitions" USING btree ("persona_id");--> statement-breakpoint
CREATE UNIQUE INDEX "funnel_defs_tenant_persona_idx" ON "funnel_definitions" USING btree ("tenant_id","persona_id");--> statement-breakpoint
CREATE UNIQUE INDEX "funnel_versions_def_version_idx" ON "funnel_versions" USING btree ("definition_id","version_number");--> statement-breakpoint
CREATE INDEX "idx_messages_conversation" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "personas_tenant_slug_idx" ON "personas" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX "personas_tenant_idx" ON "personas" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_training_tenant_persona" ON "training_jobs" USING btree ("tenant_id","persona_id");--> statement-breakpoint
CREATE INDEX "idx_training_status" ON "training_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_usage_tenant_created" ON "usage_events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_usage_tenant_persona" ON "usage_events" USING btree ("tenant_id","persona_id","created_at");