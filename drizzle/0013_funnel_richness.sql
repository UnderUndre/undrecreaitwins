DO $$ BEGIN
 CREATE TYPE "delivery_mode" AS ENUM('verbatim', 'template', 'llm');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "funnel_fragments" ADD COLUMN "delivery_mode" "delivery_mode" DEFAULT 'llm' NOT NULL;
ALTER TABLE "funnel_fragments" ADD COLUMN "adaptive_intro" boolean DEFAULT false NOT NULL;
ALTER TABLE "funnel_fragments" ADD COLUMN "media_url" text;
ALTER TABLE "funnel_fragments" ADD COLUMN "delivery_condition" jsonb;

ALTER TABLE "funnel_stages" ADD COLUMN "required_slots" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "funnel_stages" ADD COLUMN "requires_confirmation" boolean DEFAULT false NOT NULL;
ALTER TABLE "funnel_stages" ADD COLUMN "is_anytime" boolean DEFAULT false NOT NULL;

ALTER TABLE "funnel_slots" ADD COLUMN "locked" boolean DEFAULT false NOT NULL;
ALTER TABLE "funnel_slots" ADD COLUMN "enum_values" jsonb;

ALTER TABLE "conversation_funnel_states" ADD COLUMN "return_stack" jsonb DEFAULT '[]'::jsonb NOT NULL;

ALTER TABLE "conversations" ADD COLUMN "slots" jsonb DEFAULT '{}'::jsonb NOT NULL;
