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
ALTER TABLE "action_audit" DROP CONSTRAINT "action_audit_idempotency_key_unique";--> statement-breakpoint
ALTER TABLE "action_audit" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "llm_provider_config_persona_idx" ON "llm_provider_config" USING btree ("persona_id");--> statement-breakpoint
CREATE INDEX "llm_provider_config_tenant_idx" ON "llm_provider_config" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_llm_default_tenant_idx" ON "tenant_llm_default" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_api_keys_key_hash" ON "workspace_api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "idx_workspace_api_keys_workspace_id" ON "workspace_api_keys" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "action_audit" ADD CONSTRAINT "action_audit_tenant_idempotency_key_unique" UNIQUE("tenant_id","idempotency_key");