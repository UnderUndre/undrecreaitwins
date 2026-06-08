-- 014: Per-assistant MCP servers — catalog + bindings (tenant-scoped, RLS)
-- Standing Order #5: reviewed migration, NOT drizzle-kit generated

-- ─── Enums ──────────────────────────────────────────────────────────────────

CREATE TYPE "mcp_scope" AS ENUM ('tenant', 'platform');
--> statement-breakpoint
CREATE TYPE "mcp_transport" AS ENUM ('http', 'stdio');

-- ─── mcp_catalog_entry ──────────────────────────────────────────────────────

CREATE TABLE "mcp_catalog_entry" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "scope" "mcp_scope" NOT NULL DEFAULT 'tenant',
  "name" text NOT NULL,
  "transport" "mcp_transport" NOT NULL DEFAULT 'http',
  "url" text,
  "command" text,
  "args" jsonb,
  "auth_ciphertext" text,
  "auth_ref" text,
  "tools_include" jsonb,
  "tools_exclude" jsonb,
  "timeout_ms" integer NOT NULL DEFAULT 30000,
  "tls_verify" boolean NOT NULL DEFAULT true,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Composite unique (tenant_id, id) — FK target for binding cross-tenant guard
CREATE UNIQUE INDEX "mcp_catalog_entry_id_tenant_idx" ON "mcp_catalog_entry" USING btree ("id", "tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_catalog_entry_tenant_name_idx" ON "mcp_catalog_entry" USING btree ("tenant_id", "name");
--> statement-breakpoint
CREATE INDEX "mcp_catalog_entry_tenant_idx" ON "mcp_catalog_entry" USING btree ("tenant_id");

-- ─── assistant_mcp_binding ──────────────────────────────────────────────────

CREATE TABLE "assistant_mcp_binding" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "persona_id" uuid NOT NULL REFERENCES "personas" ("id") ON DELETE CASCADE,
  "catalog_entry_id" uuid NOT NULL REFERENCES "mcp_catalog_entry" ("id") ON DELETE CASCADE,
  "enabled" boolean NOT NULL DEFAULT true,
  "tool_overrides" jsonb DEFAULT '[]'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX "assistant_mcp_binding_persona_entry_idx" ON "assistant_mcp_binding" USING btree ("persona_id", "catalog_entry_id");
--> statement-breakpoint
CREATE INDEX "assistant_mcp_binding_tenant_idx" ON "assistant_mcp_binding" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "assistant_mcp_binding_persona_idx" ON "assistant_mcp_binding" USING btree ("persona_id");

-- ─── Cross-tenant guard: binding↔entry must share tenant_id ─────────────────
-- Postgres forbids subqueries in CHECK constraints ("cannot use subquery in check
-- constraint"). Enforce via a COMPOSITE FK to the UNIQUE (id, tenant_id) index on
-- mcp_catalog_entry (gemini) — a binding referencing a different-tenant entry is
-- then impossible at the DB layer (opencode F5). The plain catalog_entry_id FK
-- above still gives ON DELETE CASCADE; this adds the tenant-match leg.

ALTER TABLE "assistant_mcp_binding"
  ADD CONSTRAINT "binding_entry_same_tenant_fk"
  FOREIGN KEY ("catalog_entry_id", "tenant_id")
  REFERENCES "mcp_catalog_entry" ("id", "tenant_id")
  ON DELETE CASCADE;

-- ─── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE "mcp_catalog_entry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mcp_catalog_entry" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "mcp_catalog_entry_tenant_isolation" ON "mcp_catalog_entry"
  USING ("tenant_id" = current_setting('app.current_tenant', true))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true));
--> statement-breakpoint

ALTER TABLE "assistant_mcp_binding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assistant_mcp_binding" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "assistant_mcp_binding_tenant_isolation" ON "assistant_mcp_binding"
  USING ("tenant_id" = current_setting('app.current_tenant', true))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true));
