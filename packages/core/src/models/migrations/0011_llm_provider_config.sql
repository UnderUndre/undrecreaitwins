-- Migration: 011-llm-configuration
-- Feature: Per-Assistant LLM Provider Configuration (Runtime)
-- Review: DO NOT APPLY DIRECTLY - Standing Order 5. Review then apply via Drizzle kit.

CREATE TABLE "llm_provider_config" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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
CREATE UNIQUE INDEX "llm_provider_config_persona_idx" ON "llm_provider_config" USING btree ("persona_id");
--> statement-breakpoint
CREATE INDEX "llm_provider_config_tenant_idx" ON "llm_provider_config" USING btree ("tenant_id");
--> statement-breakpoint

CREATE TABLE "tenant_llm_default" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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
CREATE UNIQUE INDEX "tenant_llm_default_tenant_idx" ON "tenant_llm_default" USING btree ("tenant_id");
