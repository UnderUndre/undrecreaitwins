-- Tuning drafts: RLS via tenant_id column (same pattern as personas et al.)
ALTER TABLE tuning_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tuning_drafts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tuning_drafts
  USING (tenant_id = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true));
