CREATE TABLE "tuning_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"persona_id" text NOT NULL,
	"method" text NOT NULL,
	"status" text DEFAULT 'generating' NOT NULL,
	"confidence" text,
	"system_prompt" text,
	"funnel_config" jsonb,
	"validator_toggles" jsonb,
	"diff_sections" jsonb,
	"previous_snapshot" jsonb,
	"signals" jsonb,
	"error" text,
	"review_verdict" text,
	"review_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "conversation_funnel_states" ADD COLUMN "return_stack" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_funnel_states" ADD COLUMN "pending_confirmation" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "slots" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "funnel_fragments" ADD COLUMN "delivery_mode" "delivery_mode" DEFAULT 'llm' NOT NULL;--> statement-breakpoint
ALTER TABLE "funnel_fragments" ADD COLUMN "adaptive_intro" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "funnel_fragments" ADD COLUMN "media_url" text;--> statement-breakpoint
ALTER TABLE "funnel_fragments" ADD COLUMN "delivery_condition" jsonb;--> statement-breakpoint
ALTER TABLE "funnel_slots" ADD COLUMN "locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "funnel_slots" ADD COLUMN "enum_values" jsonb;--> statement-breakpoint
ALTER TABLE "funnel_stages" ADD COLUMN "required_slots" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "funnel_stages" ADD COLUMN "requires_confirmation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "funnel_stages" ADD COLUMN "confirmation_prompt" text;--> statement-breakpoint
ALTER TABLE "funnel_stages" ADD COLUMN "is_anytime" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "funnel_stages" ADD COLUMN "anytime_triggers" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "validator_configs" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_tuning_drafts_persona_status" ON "tuning_drafts" USING btree ("persona_id","status");--> statement-breakpoint
CREATE INDEX "idx_tuning_drafts_tenant_status" ON "tuning_drafts" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_tuning_drafts_created_at" ON "tuning_drafts" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tuning_drafts_persona_generating" ON "tuning_drafts" USING btree ("persona_id") WHERE status = 'generating';
--> statement-breakpoint
-- NOTE: This migration bundles tuning_drafts + funnel/validator schema changes.
-- Should have been two separate migrations. Do not repeat this pattern.
--> statement-breakpoint
ALTER TABLE "tuning_drafts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tuning_drafts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tuning_drafts"
  USING (tenant_id = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true));
--> statement-breakpoint
ALTER TABLE "tuning_drafts" ADD CONSTRAINT "tuning_drafts_persona_id_personas_id_fk"
  FOREIGN KEY ("persona_id") REFERENCES "personas"("id") ON DELETE cascade;