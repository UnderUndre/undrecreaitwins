import type { FastifyPluginAsync } from 'fastify';
import { UnauthorizedError } from '@undrecreaitwins/shared';
import { db } from '../db.js';
import { tenants } from '../models/index.js';
import { eq } from 'drizzle-orm';

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
  }
}

export const tenantPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', async (request) => {
    const tenantId = request.headers['x-tenant-id'] as string | undefined;
    const tenantClaim = request.headers['x-tenant-claim'] as string | undefined;

    let resolvedTenantId: string | undefined;

    if (tenantClaim) {
      try {
        const payload = JSON.parse(Buffer.from(tenantClaim, 'base64url').toString());
        resolvedTenantId = payload.tenant;
      } catch {}
    }

    if (!resolvedTenantId && tenantId) {
      resolvedTenantId = tenantId;
    }

    if (!resolvedTenantId) {
      throw new UnauthorizedError('Missing tenant context');
    }

    const [tenant] = await db
      .select({ id: tenants.id, status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, resolvedTenantId))
      .limit(1);

    if (!tenant || tenant.status !== 'active') {
      throw new UnauthorizedError('Invalid or inactive tenant');
    }

    request.tenantId = resolvedTenantId;
  });
};
