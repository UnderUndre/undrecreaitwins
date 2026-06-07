CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"total_cases" integer NOT NULL,
	"passed_cases" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"case_name" text NOT NULL,
	"passed" boolean NOT NULL,
	"response" text NOT NULL,
	"assertion_results" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_run_id_eval_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."eval_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "eval_runs_tenant_started_idx" ON "eval_runs" USING btree ("tenant_id","started_at");
--> statement-breakpoint
CREATE INDEX "eval_results_run_idx" ON "eval_results" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "eval_results_tenant_run_idx" ON "eval_results" USING btree ("tenant_id","run_id");
--> statement-breakpoint
ALTER TABLE "eval_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "eval_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "eval_results" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "eval_results" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "eval_runs"
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "eval_results"
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
