CREATE TYPE "public"."validator_mode" AS ENUM('active', 'dry-run');--> statement-breakpoint
CREATE TYPE "public"."validator_verdict" AS ENUM('no_op', 'append_disclaimer', 'block', 'rewrite', 'error');--> statement-breakpoint
CREATE TABLE "validator_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
	"validator_name" text NOT NULL,
	"mode" "validator_mode" DEFAULT 'active' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "validator_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"persona_id" uuid NOT NULL,
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
ALTER TABLE "validator_configs" ADD CONSTRAINT "validator_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validator_configs" ADD CONSTRAINT "validator_configs_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validator_runs" ADD CONSTRAINT "validator_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validator_runs" ADD CONSTRAINT "validator_runs_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validator_runs" ADD CONSTRAINT "validator_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validator_runs" ADD CONSTRAINT "validator_runs_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "validator_configs_tenant_persona_name_idx" ON "validator_configs" USING btree ("tenant_id","persona_id","validator_name");--> statement-breakpoint
CREATE INDEX "validator_configs_tenant_idx" ON "validator_configs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "validator_runs_tenant_persona_idx" ON "validator_runs" USING btree ("tenant_id","persona_id");--> statement-breakpoint
CREATE INDEX "validator_runs_conversation_idx" ON "validator_runs" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "validator_runs_tenant_created_idx" ON "validator_runs" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "validator_configs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "validator_configs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "validator_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "validator_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "validator_configs" USING (tenant_id = current_setting('app.current_tenant', true)::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "validator_runs" USING (tenant_id = current_setting('app.current_tenant', true)::uuid);