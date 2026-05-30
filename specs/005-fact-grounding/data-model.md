# Data Model: Fact Grounding (005)

**This feature does NOT introduce new tables.**

As per the specification (aligned with the 008-agent-builder substrate), Fact Grounding shares the vector storage substrate with the Agent Builder feature. 
All data modeling for documents, document chunks, and embeddings is defined and managed in `008-agent-builder/data-model.md`.

- **Vector Storage**: `pgvector` extension in PostgreSQL
- **Tables used**: `documents`, `document_chunks` (defined in 008)
- **Embedding Dimension**: 1024 (BGE-M3)
