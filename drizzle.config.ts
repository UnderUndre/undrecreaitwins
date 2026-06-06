import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './packages/core/src/models/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://undre:changeme@localhost:5433/twinengine',
  },
});
