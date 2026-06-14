import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { errorHandler } from '@undrecreaitwins/core/middleware/error-handler.js';
import { healthCheck as dbHealthCheck } from '@undrecreaitwins/core/db.js';
import { UnauthorizedError, ForbiddenError, AppError } from '@undrecreaitwins/shared';
import { createHash } from 'crypto';
import { db } from '@undrecreaitwins/core/db.js';
import { tenants, apiTokens } from '@undrecreaitwins/core/models/index.js';
import { eq, and, isNull } from 'drizzle-orm';

import { personaRoutes } from './routes/personas.js';
import { chatCompletionsRoutes } from './routes/chat-completions.js';
import { annotationRoutes } from './routes/annotations.js';
import { documentRoutes } from './routes/documents.js';
import { sandboxRoutes } from './routes/sandbox.js';
import { llmProviderRoutes } from './routes/llm-provider.js';
import { mcpCatalogRoutes } from './routes/mcp-catalog.js';
import { channelRoutes } from './routes/channels.js';
import { fallbackRoutes } from './routes/fallback.js';
import { behaviorRoutes } from './routes/behavior.js';
import { retryJobsRoutes } from './routes/retry-jobs.js';
import { correctionRulesReloadRoutes } from './routes/correction-rules-reload.js';
import { retrievedFeedbackRoutes } from './routes/retrieved-feedback.js';
import { authPublicPlugin } from './middleware/auth-public.js';
import { publicModelsRoute } from './routes/v1/openai/models.js';
import { publicChatRoute } from './routes/v1/openai/chat.js';
import { ProviderRetryWorker } from '@undrecreaitwins/core/services/retry/provider-retry.worker.js';
import { runHermesPreflight, type PreflightResult } from '@undrecreaitwins/core/services/hermes/hermes-preflight.js';
import { setDegradationSignal } from '@undrecreaitwins/core/services/hermes/honcho-client.js';

const retryWorker = new ProviderRetryWorker();

const PUBLIC_API_KEY_PREFIX = 'sk-aitw_';
const PUBLIC_ROUTES = new Set(['/v1/models', '/v1/chat/completions']);

function isPublicApiKeyRequest(request: { url: string; headers: Record<string, string | string[] | undefined> }): boolean {
  const url = request.url.split('?')[0]!;
  if (!PUBLIC_ROUTES.has(url)) return false;
  const authHeader = request.headers.authorization as string | undefined;
  return !!authHeader?.startsWith(`Bearer ${PUBLIC_API_KEY_PREFIX}`);
}

let cachedPreflightResult: PreflightResult | undefined;
let honchoMemoryStatus: 'ok' | 'degraded' | 'error' = 'ok';

export function getHonchoMemoryStatus(): 'ok' | 'degraded' | 'error' {
  return honchoMemoryStatus;
}

export function setHonchoMemoryStatus(status: 'ok' | 'degraded' | 'error'): void {
  honchoMemoryStatus = status;
}

export function getPreflightResult(): PreflightResult | undefined {
  return cachedPreflightResult;
}

export async function buildServer() {
  cachedPreflightResult = await runHermesPreflight();
  if (!cachedPreflightResult.ok) {
    throw new AppError(
      cachedPreflightResult.error.message,
      500,
      'configuration_error',
    );
  }

  setDegradationSignal((cls: 'transient' | 'permanent') => {
    if (cls === 'permanent') {
      honchoMemoryStatus = 'error';
    } else {
      honchoMemoryStatus = honchoMemoryStatus === 'error' ? 'error' : 'degraded';
    }
  });

  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      redact: [
        'req.body.messages[*].content',
        'req.body.config.bot_token',
        'res.body.choices[*].message.content',
      ],
    },
  });

  await fastify.register(cors, { origin: true });

  await fastify.register(multipart, {
    limits: {
      fileSize: parseInt(process.env.TWIN_MAX_UPLOAD_BYTES || '524288000', 10),
    },
  });

  fastify.get('/v1/health', async () => {
    const dbOk = await dbHealthCheck();
    const checks: Record<string, string> = {
      database: dbOk ? 'ok' : 'error',
    };

    if (cachedPreflightResult?.ok && cachedPreflightResult.acpProtocolVersion > 0) {
      checks.hermes_runtime = 'ok';
    }

    if (honchoMemoryStatus !== 'ok') {
      checks.honcho_memory = honchoMemoryStatus;
    }

    const allOk = dbOk && (honchoMemoryStatus === 'ok');
    return {
      status: allOk ? 'ok' : 'degraded',
      version: process.env.npm_package_version || '0.0.0',
      checks,
    };
  });

  fastify.setErrorHandler(errorHandler);

  fastify.addHook('onRequest', async (request) => {
    if (request.url === '/v1/health') return;
    if (isPublicApiKeyRequest(request)) return;
    const tenantId = request.headers['x-tenant-id'] as string | undefined;
    const tenantClaim = request.headers['x-tenant-claim'] as string | undefined;
    let resolvedTenantId: string | undefined;
    if (tenantClaim) {
      try {
        const payload = JSON.parse(Buffer.from(tenantClaim, 'base64url').toString());
        resolvedTenantId = payload.tenant;
      } catch {}
    }
    if (!resolvedTenantId && tenantId) resolvedTenantId = tenantId;
    if (!resolvedTenantId) throw new UnauthorizedError('Missing tenant context');
    const [tenant] = await db.select({ id: tenants.id, status: tenants.status }).from(tenants).where(eq(tenants.id, resolvedTenantId)).limit(1);
    if (!tenant) {
      await db.insert(tenants).values({ id: resolvedTenantId, status: 'active' }).onConflictDoNothing();
    } else if (tenant.status !== 'active') {
      throw new UnauthorizedError('Invalid or inactive tenant');
    }
    (request as any).tenantId = resolvedTenantId;
  });

  fastify.addHook('onRequest', async (request) => {
    if (request.url === '/v1/health') return;
    if (isPublicApiKeyRequest(request)) return;
    const authMode = process.env.TWIN_AUTH_MODE || 'standalone';
    if (authMode === 'gateway') return;
    const staticToken = process.env.TWIN_AUTH_STATIC_TOKEN;
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) throw new UnauthorizedError('Missing or invalid Authorization header');
    const token = authHeader.slice(7);
    if (staticToken && token === staticToken) return;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const [found] = await db.select({ id: apiTokens.id, tenantId: apiTokens.tenantId }).from(apiTokens).where(and(eq(apiTokens.tokenHash, tokenHash), isNull(apiTokens.revokedAt))).limit(1);
    if (!found) throw new UnauthorizedError('Invalid or revoked API token');
    if ((request as any).tenantId && (request as any).tenantId !== found.tenantId) throw new ForbiddenError('Token tenant mismatch');
    (request as any).tenantId = found.tenantId;
  });

  await fastify.register(personaRoutes);
  await fastify.register(chatCompletionsRoutes, { prefix: '/internal' });
  await fastify.register(annotationRoutes);
  await fastify.register(documentRoutes);
  await fastify.register(sandboxRoutes);
  await fastify.register(llmProviderRoutes);
  await fastify.register(mcpCatalogRoutes);
  await fastify.register(channelRoutes);
  await fastify.register(fallbackRoutes);
  await fastify.register(behaviorRoutes);
  await fastify.register(retryJobsRoutes);
  await fastify.register(correctionRulesReloadRoutes);
  await fastify.register(retrievedFeedbackRoutes);

  await fastify.register(async (publicApi) => {
    await publicApi.register(authPublicPlugin);
    await publicApi.register(publicModelsRoute);
    await publicApi.register(publicChatRoute);
  });

  return fastify;
}

export async function start() {
  const server = await buildServer();
  const port = parseInt(process.env.PORT || '8090', 10);
  await server.listen({ port, host: '0.0.0.0' });
  
  await retryWorker.start();

  const shutdown = async () => {
    await retryWorker.stop();
    await server.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return server;
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
