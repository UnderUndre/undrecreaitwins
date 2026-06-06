import { createHmac, randomBytes } from 'node:crypto';
import { eq, and, isNull } from 'drizzle-orm';
import { db, withTenantContext } from '../db.js';
import { workspaceApiKeys } from '../models/api-key.js';

const HMAC_ALGO = 'sha256';
const KEY_PREFIX = 'sk-aitw_';
const KEY_BYTES = 32;

function getHmacSecret(): string {
  const secret = process.env.API_KEY_HMAC_SECRET;
  if (!secret) throw new Error('API_KEY_HMAC_SECRET env var is required');
  return secret;
}

function hashKey(plaintextKey: string): string {
  return createHmac(HMAC_ALGO, getHmacSecret()).update(plaintextKey).digest('hex');
}

function generatePlaintextKey(): string {
  return KEY_PREFIX + randomBytes(KEY_BYTES).toString('hex');
}

export interface ApiKeyMeta {
  id: string;
  workspaceId: string;
  keyPrefix: string;
  name: string;
  mode: 'test' | 'live';
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface CreateKeyResult {
  meta: ApiKeyMeta;
  plaintextKey: string;
}

export interface RotateKeyResult {
  meta: ApiKeyMeta;
  plaintextKey: string;
  revokedKey: ApiKeyMeta;
}

function toMeta(row: typeof workspaceApiKeys.$inferSelect): ApiKeyMeta {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    keyPrefix: row.keyPrefix,
    name: row.name,
    mode: row.mode as 'test' | 'live',
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

export const ApiKeyService = {
  async generateKey(
    workspaceId: string,
    name: string,
    mode: 'test' | 'live',
    expiresAt?: Date,
  ): Promise<CreateKeyResult> {
    const plaintextKey = generatePlaintextKey();
    const keyHash = hashKey(plaintextKey);
    const keyPrefix = plaintextKey.slice(0, 12);

    const [row] = await withTenantContext(workspaceId, async (tx) =>
      tx
        .insert(workspaceApiKeys)
        .values({
          workspaceId,
          keyHash,
          keyPrefix,
          name,
          mode,
          expiresAt: expiresAt ?? null,
        })
        .returning(),
    );

    if (!row) throw new Error('Failed to create API key');
    return { meta: toMeta(row), plaintextKey };
  },

  async validateKey(
    plaintextKey: string,
  ): Promise<(ApiKeyMeta & { workspaceId: string }) | null> {
    const keyHash = hashKey(plaintextKey);

    const rows = await db
      .select()
      .from(workspaceApiKeys)
      .where(and(eq(workspaceApiKeys.keyHash, keyHash), isNull(workspaceApiKeys.revokedAt)))
      .limit(1);

    if (rows.length === 0) return null;

    const row = rows[0]!;

    if (row.expiresAt && row.expiresAt < new Date()) return null;

    return toMeta(row);
  },

  async listKeys(workspaceId: string): Promise<ApiKeyMeta[]> {
    const rows = await withTenantContext(workspaceId, async (tx) =>
      tx
        .select()
        .from(workspaceApiKeys)
        .where(eq(workspaceApiKeys.workspaceId, workspaceId))
        .orderBy(workspaceApiKeys.createdAt),
    );
    return rows.map(toMeta);
  },

  async revokeKey(keyId: string, workspaceId: string): Promise<ApiKeyMeta | null> {
    const [row] = await withTenantContext(workspaceId, async (tx) =>
      tx
        .update(workspaceApiKeys)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(workspaceApiKeys.id, keyId),
            eq(workspaceApiKeys.workspaceId, workspaceId),
            isNull(workspaceApiKeys.revokedAt),
          ),
        )
        .returning(),
    );
    return row ? toMeta(row) : null;
  },

  async rotateKey(
    keyId: string,
    workspaceId: string,
  ): Promise<RotateKeyResult | null> {
    return withTenantContext(workspaceId, async (tx) => {
      const [revoked] = await tx
        .update(workspaceApiKeys)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(workspaceApiKeys.id, keyId),
            eq(workspaceApiKeys.workspaceId, workspaceId),
            isNull(workspaceApiKeys.revokedAt),
          ),
        )
        .returning();

      if (!revoked) return null;

      const plaintextKey = generatePlaintextKey();
      const keyHash = hashKey(plaintextKey);
      const keyPrefix = plaintextKey.slice(0, 12);

      const [created] = await tx
        .insert(workspaceApiKeys)
        .values({
          workspaceId,
          keyHash,
          keyPrefix,
          name: revoked.name,
          mode: revoked.mode,
          expiresAt: revoked.expiresAt,
        })
        .returning();

      if (!created) return null;

      return {
        meta: toMeta(created),
        plaintextKey,
        revokedKey: toMeta(revoked),
      };
    });
  },

  async touchLastUsed(keyId: string): Promise<void> {
    await db
      .update(workspaceApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(workspaceApiKeys.id, keyId));
  },
};
