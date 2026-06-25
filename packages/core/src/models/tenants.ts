import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

  /** Grounding mode: 'vector' (default, RAG) or 'big-context' (all-in-prompt). */
  groundingMode: text('grounding_mode').notNull().default('vector').$type<'vector' | 'big-context'>(),
});
