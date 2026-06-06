import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';

export const workspaceApiKeys = pgTable(
  'workspace_api_keys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    keyHash: text('key_hash').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    name: text('name').notNull(),
    mode: text('mode').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => ({
    keyHashIdx: index('idx_workspace_api_keys_key_hash').on(table.keyHash),
    workspaceIdx: index('idx_workspace_api_keys_workspace_id').on(table.workspaceId),
  }),
);
