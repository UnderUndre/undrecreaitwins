-- 0012_feedback_memories.sql
-- Creates feedback_memories + conversation_feedback_states tables (019 feedback-loop-closure)
-- Adds feedback config columns to personas
-- Review-only — do NOT execute without explicit approval

-- feedback_memories table
CREATE TABLE feedback_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  context_embedding VECTOR(1024) NOT NULL,
  lesson TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'archived')),
  operator_role TEXT,
  weight REAL DEFAULT 1.0,
  source_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- HNSW index for cosine vector search
CREATE INDEX feedback_memories_context_embedding_hnsw_idx
  ON feedback_memories USING hnsw (context_embedding vector_cosine_ops);

-- Filtered retrieval index
CREATE INDEX feedback_memories_tenant_persona_status_idx
  ON feedback_memories (tenant_id, persona_id, status);

-- conversation_feedback_states table
CREATE TABLE conversation_feedback_states (
  conversation_id UUID PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  applied_feedback_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_stage_label TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Persona config extension
ALTER TABLE personas
  ADD COLUMN feedback_retrieval_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN feedback_token_budget INTEGER NOT NULL DEFAULT 500;

-- Enable RLS on new tables
ALTER TABLE feedback_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_feedback_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY feedback_memories_tenant_isolation ON feedback_memories
  USING (tenant_id = current_setting('app.current_tenant', true));

CREATE POLICY conversation_feedback_states_tenant_isolation ON conversation_feedback_states
  USING (EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = conversation_feedback_states.conversation_id
    AND c.tenant_id = current_setting('app.current_tenant', true)
  ));
