-- Enable + FORCE RLS on all tenant-scoped tables.
-- FORCE is required because the table owner (typically the app's connection role)
-- bypasses RLS by default — without FORCE, tenant isolation fails for the owner.
ALTER TABLE personas ENABLE ROW LEVEL SECURITY;
ALTER TABLE personas FORCE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE channel_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_instances FORCE ROW LEVEL SECURITY;
ALTER TABLE training_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;
ALTER TABLE api_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_tokens FORCE ROW LEVEL SECURITY;

-- Standard tenant isolation policy (tenant_id = current_setting)
CREATE POLICY tenant_isolation ON personas
  USING (tenant_id = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON conversations
  USING (tenant_id = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON channel_instances
  USING (tenant_id = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON training_jobs
  USING (tenant_id = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON usage_events
  USING (tenant_id = current_setting('app.current_tenant')::uuid);

CREATE POLICY tenant_isolation ON api_tokens
  USING (tenant_id = current_setting('app.current_tenant')::uuid);

-- Messages: RLS via EXISTS join on parent conversation
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_messages ON messages
  USING (
    EXISTS (
      SELECT 1 FROM conversations
      WHERE conversations.id = messages.conversation_id
        AND conversations.tenant_id = current_setting('app.current_tenant')::uuid
    )
  );

-- tenants table: NO RLS (reference table, managed externally)
