import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { tenantPlugin } from '@undrecreaitwins/core/middleware/tenant.js';
import { authPlugin } from '@undrecreaitwins/core/middleware/auth.js';
import { errorHandler } from '@undrecreaitwins/core/middleware/error-handler.js';
import { healthCheck as dbHealthCheck } from '@undrecreaitwins/core/db.js';

import { personaRoutes } from './routes/personas.js';
import { chatCompletionsRoutes } from './routes/chat-completions.js';
import { annotationRoutes } from './routes/annotations.js';
import { documentRoutes } from './routes/documents.js';
import { sandboxRoutes } from './routes/sandbox.js';

export async function buildServer() {
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
    return {
      status: dbOk ? 'ok' : 'degraded',
      version: process.env.npm_package_version || '0.0.0',
      checks: {
        database: dbOk ? 'ok' : 'error',
      },
    };
  });

  await fastify.register(tenantPlugin);
  await fastify.register(authPlugin);

  // Routes
  await fastify.register(personaRoutes);
  await fastify.register(chatCompletionsRoutes);
  await fastify.register(annotationRoutes);
  await fastify.register(documentRoutes);
  await fastify.register(sandboxRoutes);

  fastify.setErrorHandler(errorHandler);

  return fastify;
}

export async function start() {
  const server = await buildServer();
  const port = parseInt(process.env.PORT || '8090', 10);
  await server.listen({ port, host: '0.0.0.0' });
  return server;
}
