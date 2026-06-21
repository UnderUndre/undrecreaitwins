import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { UnauthorizedError } from './errors.js';

export function resolveKey(request: FastifyRequest, provider: 'openai' | 'cohere' | 'jina'): string {
  const authHeader = request.headers.authorization;
  if (authHeader) {
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7).trim();
      if (token) return token;
    } else {
      const token = authHeader.trim();
      if (token) return token;
    }
  }

  // Fallback to env config
  let envKey: string | undefined;
  if (provider === 'openai') {
    envKey = config.OPENAI_API_KEY;
  } else if (provider === 'cohere') {
    envKey = config.COHERE_API_KEY;
  } else if (provider === 'jina') {
    envKey = config.JINA_API_KEY;
  }

  if (!envKey) {
    throw new UnauthorizedError(`No API key provided for provider ${provider}`);
  }

  return envKey;
}
