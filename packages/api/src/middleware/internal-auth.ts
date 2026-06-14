import type { FastifyRequest, FastifyReply } from 'fastify';

const INTERNAL_SECRET = process.env.TWIN_INTERNAL_WEBHOOK_SECRET;

export async function internalAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!INTERNAL_SECRET) {
    reply.code(503).send({ error: 'Internal auth not configured' });
    return;
  }

  const auth = request.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Missing Bearer token' });
    return;
  }

  const token = auth.slice(7);
  if (token !== INTERNAL_SECRET) {
    reply.code(401).send({ error: 'Invalid secret' });
    return;
  }
}
