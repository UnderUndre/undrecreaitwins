import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './models/index.js';
import { sql } from 'drizzle-orm';

const connectionString = process.env.DATABASE_URL || 'postgresql://undre:changeme@localhost:5433/twinengine';

const client = postgres(connectionString, {
  max: 20,
  idle_timeout: 20_000,
  connect_timeout: 10_000,
});

export const db = drizzle(client, { schema });

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function withTenantContext<T>(
  tenantId: string,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_tenant', ${tenantId}, true)`);
    return fn(tx);
  });
}

export async function healthCheck(): Promise<boolean> {
  try {
    await client`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
