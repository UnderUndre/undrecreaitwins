import pg from 'pg';

const { Client } = pg;

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // pgvector extension — required by vector(1024) columns in schema (annotations, document_chunks)
  await client.query('CREATE EXTENSION IF NOT EXISTS vector');

  // Enum types that drizzle-kit push may reorder incorrectly (CREATE TYPE after ALTER TABLE)
  // delivery_mode is created in 0013_funnel_richness.sql — not in _journal.json
  await client.query(`
    DO $$ BEGIN
      CREATE TYPE delivery_mode AS ENUM('verbatim', 'template', 'llm');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await client.end();
  console.log('[db-init] Extensions and enum types ensured');
}

main().catch((e) => {
  console.error('[db-init] Failed:', e.message);
  process.exit(1);
});
