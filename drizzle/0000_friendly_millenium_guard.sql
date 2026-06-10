CREATE TYPE "public"."fragment_type" AS ENUM('normal', 'objection');--> statement-breakpoint
CREATE TYPE "public"."mcp_scope" AS ENUM('tenant', 'platform');--> statement-breakpoint
CREATE TYPE "public"."mcp_transport" AS ENUM('http', 'stdio');--> statement-breakpoint
CREATE TYPE "public"."validator_mode" AS ENUM('active', 'dry-run');--> statement-breakpoint
CREATE TYPE "public"."validator_verdict" AS ENUM('no_op', 'append_disclaimer', 'block', 'rewrite', 'error');--> statement-breakpoint
CREATE TABLE "action_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"persona_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"args_json" text,
	"result_json" text,
	"idempotency_key" text NOT NULL,
	"is_write_action" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_audit_tenant_idempotency_key_unique" UNIQUE("tenant_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"persona_id" text NOT NULL,
	"conversation_id" text,
	"kind" text DEFAULT 'agentic' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"input_preview" text,
	"output_preview" text,
	"steps_json" jsonb,
	"usage_json" jsonb,
	"loop_iterations" integer DEFAULT 0,
	"tokens_used" integer DEFAULT 0,
	"error_message" text,
	"routing_decision" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "annotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"persona_id" text NOT NULL,
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
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "assistant_mcp_binding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"persona_id" text NOT NULL,
	"catalog_entry_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"tool_overrides" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"persona_id" text NOT NULL,
	"channel_type" text NOT NULL,
	"config" jsonb NOT NULL,
	"credentials_ciphertext" text,
	"kms_key_ref" text,
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
	"tenant_id" text NOT NULL,
	"persona_id" text NOT NULL,
	"channel_id" uuid,
	"external_user_id" text NOT NULL,
	"summary" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"message_count" integer DEFAULT 0 NOT NULL,
	"is_test_thread" boolean DEFAULT false NOT NULL,
	"source" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"needs_reengagement" boolean DEFAULT true NOT NULL,
	"last_reengagement_at" timestamp with time zone,
	"reengagement_count" integer DEFAULT 0 NOT NULL,
	"opted_out" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"document_id" uuid NOT NULL,
	"persona_id" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"persona_id" text NOT NULL,
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
	"tenant_id" text NOT NULL,
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
	"tenant_id" text NOT NULL,
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
CREATE TABLE "funnel_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"persona_id" text NOT NULL,
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
CREATE TABLE "llm_provider_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"persona_id" text NOT NULL,
	"provider_type" text DEFAULT 'custom' NOT NULL,
	"base_url" text NOT NULL,
	"model_id" text NOT NULL,
	"api_key_ciphertext" text NOT NULL,
	"api_key_ref" text NOT NULL,
	"temperature" real,
	"max_tokens" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_catalog_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"scope" "mcp_scope" DEFAULT 'tenant' NOT NULL,
	"name" text NOT NULL,
	"transport" "mcp_transport" DEFAULT 'http' NOT NULL,
	"url" text,
	"command" text,
	"args" jsonb,
	"auth_ciphertext" text,
	"auth_ref" text,
	"tools_include" jsonb,
	"tools_exclude" jsonb,
	"timeout_ms" integer DEFAULT 30000 NOT NULL,
	"tls_verify" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"system_prompt" text NOT NULL,
	"traits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"model_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"annotation_similarity_threshold" real DEFAULT 0.7 NOT NULL,
	"has_annotations" boolean DEFAULT false NOT NULL,
	"agent_enabled" boolean DEFAULT false NOT NULL,
	"tool_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agent_config" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_llm_default" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"provider_type" text DEFAULT 'custom' NOT NULL,
	"base_url" text NOT NULL,
	"model_id" text NOT NULL,
	"api_key_ciphertext" text NOT NULL,
	"api_key_ref" text NOT NULL,
	"temperature" real,
	"max_tokens" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"persona_id" text NOT NULL,
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
	"tenant_id" text NOT NULL,
	"persona_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "validator_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"persona_id" text NOT NULL,
	"validator_name" text NOT NULL,
	"mode" "validator_mode" DEFAULT 'active' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "validator_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"persona_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid,
	"validator_name" text NOT NULL,
	"verdict" "validator_verdict" NOT NULL,
	"confidence" double precision,
	"matched_patterns" jsonb DEFAULT '[]'::jsonb,
	"original_content" text NOT NULL,
	"remediated_content" text,
	"latency_ms" integer,
	"is_dry_run" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"name" text NOT NULL,
	"mode" text NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_mcp_binding" ADD CONSTRAINT "assistant_mcp_binding_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_mcp_binding" ADD CONSTRAINT "assistant_mcp_binding_catalog_entry_id_mcp_catalog_entry_id_fk" FOREIGN KEY ("catalog_entry_id") REFERENCES "public"."mcp_catalog_entry"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_funnel_states" ADD CONSTRAINT "conversation_funnel_states_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_funnel_states" ADD CONSTRAINT "conversation_funnel_states_funnel_version_id_funnel_versions_id_fk" FOREIGN KEY ("funnel_version_id") REFERENCES "public"."funnel_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_funnel_states" ADD CONSTRAINT "conversation_funnel_states_current_stage_id_funnel_stages_id_fk" FOREIGN KEY ("current_stage_id") REFERENCES "public"."funnel_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followup_attempts" ADD CONSTRAINT "followup_attempts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followup_attempts" ADD CONSTRAINT "followup_attempts_rule_id_followup_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."followup_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "validator_configs" ADD CONSTRAINT "validator_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validator_configs" ADD CONSTRAINT "validator_configs_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validator_runs" ADD CONSTRAINT "validator_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validator_runs" ADD CONSTRAINT "validator_runs_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validator_runs" ADD CONSTRAINT "validator_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validator_runs" ADD CONSTRAINT "validator_runs_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_audit_sweep_idx" ON "action_audit" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "action_audit_tenant_idx" ON "action_audit" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "agent_runs_tenant_idx" ON "agent_runs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "agent_runs_persona_idx" ON "agent_runs" USING btree ("persona_id");--> statement-breakpoint
CREATE INDEX "agent_runs_created_at_idx" ON "agent_runs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "annotations_tenant_persona_query_idx" ON "annotations" USING btree ("tenant_id","persona_id","normalized_query");--> statement-breakpoint
CREATE INDEX "annotations_tenant_persona_idx" ON "annotations" USING btree ("tenant_id","persona_id");--> statement-breakpoint
CREATE INDEX "idx_api_tokens_token_hash" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_mcp_binding_persona_entry_idx" ON "assistant_mcp_binding" USING btree ("persona_id","catalog_entry_id");--> statement-breakpoint
CREATE INDEX "assistant_mcp_binding_tenant_idx" ON "assistant_mcp_binding" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "assistant_mcp_binding_persona_idx" ON "assistant_mcp_binding" USING btree ("persona_id");--> statement-breakpoint
CREATE INDEX "idx_channels_tenant" ON "channel_instances" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_channels_tenant_persona" ON "channel_instances" USING btree ("tenant_id","persona_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_tenant_persona" ON "conversations" USING btree ("tenant_id","persona_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_tenant" ON "conversations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_reengagement_scan" ON "conversations" USING btree ("tenant_id","needs_reengagement","last_message_at");--> statement-breakpoint
CREATE INDEX "document_chunks_tenant_persona_idx" ON "document_chunks" USING btree ("tenant_id","persona_id");--> statement-breakpoint
CREATE INDEX "documents_tenant_persona_idx" ON "documents" USING btree ("tenant_id","persona_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_followup_attempts_idempotency" ON "followup_attempts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_followup_attempts_tenant_status_scheduled" ON "followup_attempts" USING btree ("tenant_id","status","scheduled_at");--> statement-breakpoint
CREATE INDEX "idx_followup_attempts_tenant_status_claimed" ON "followup_attempts" USING btree ("tenant_id","status","claimed_at");--> statement-breakpoint
CREATE INDEX "idx_followup_rules_tenant_active" ON "followup_rules" USING btree ("tenant_id","is_active");--> statement-breakpoint
CREATE INDEX "funnel_defs_tenant_idx" ON "funnel_definitions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "funnel_defs_persona_idx" ON "funnel_definitions" USING btree ("persona_id");--> statement-breakpoint
CREATE UNIQUE INDEX "funnel_defs_tenant_persona_idx" ON "funnel_definitions" USING btree ("tenant_id","persona_id");--> statement-breakpoint
CREATE UNIQUE INDEX "funnel_versions_def_version_idx" ON "funnel_versions" USING btree ("definition_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "funnel_versions_active_idx" ON "funnel_versions" USING btree ("definition_id") WHERE "funnel_versions"."is_active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "llm_provider_config_persona_idx" ON "llm_provider_config" USING btree ("persona_id");--> statement-breakpoint
CREATE INDEX "llm_provider_config_tenant_idx" ON "llm_provider_config" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_catalog_entry_tenant_name_idx" ON "mcp_catalog_entry" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "mcp_catalog_entry_tenant_idx" ON "mcp_catalog_entry" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_catalog_entry_id_tenant_idx" ON "mcp_catalog_entry" USING btree ("id","tenant_id");--> statement-breakpoint
CREATE INDEX "idx_messages_conversation" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "personas_tenant_slug_idx" ON "personas" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX "personas_tenant_idx" ON "personas" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_llm_default_tenant_idx" ON "tenant_llm_default" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_training_tenant_persona" ON "training_jobs" USING btree ("tenant_id","persona_id");--> statement-breakpoint
CREATE INDEX "idx_training_status" ON "training_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_usage_tenant_created" ON "usage_events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_usage_tenant_persona" ON "usage_events" USING btree ("tenant_id","persona_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "validator_configs_tenant_persona_name_idx" ON "validator_configs" USING btree ("tenant_id","persona_id","validator_name");--> statement-breakpoint
CREATE INDEX "validator_configs_tenant_idx" ON "validator_configs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "validator_runs_tenant_persona_idx" ON "validator_runs" USING btree ("tenant_id","persona_id");--> statement-breakpoint
CREATE INDEX "validator_runs_conversation_idx" ON "validator_runs" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "validator_runs_tenant_created_idx" ON "validator_runs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_workspace_api_keys_key_hash" ON "workspace_api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "idx_workspace_api_keys_workspace_id" ON "workspace_api_keys" USING btree ("workspace_id");