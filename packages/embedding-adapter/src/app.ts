import Fastify from 'fastify';
import { config } from './config.js';
import { errorHandler } from './lib/errors.js';
import { embedRoutes } from './routes/embed.js';
import { rerankRoutes } from './routes/rerank.js';
import { healthRoutes } from './routes/health.js';

export const app = Fastify({
  bodyLimit: config.BODY_LIMIT,
  logger: {
    level: config.LOG_LEVEL,
    redact: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'req.headers["openai-api-key"]',
      'req.headers["cohere-api-key"]',
      'req.headers["jina-api-key"]',
      'req.body.inputs',
      'req.body.documents',
      'req.body.query',
      'err.inputs',
      'err.documents',
      'inputs',
      'documents',
    ],
  },
});

// Set custom error handler
app.setErrorHandler(errorHandler);

// Register routes
await app.register(embedRoutes);
await app.register(rerankRoutes);
await app.register(healthRoutes);
