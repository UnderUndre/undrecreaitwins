import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
    apiKeyMeta?: {
      keyId: string;
      mode: 'test' | 'live';
      workspaceId: string;
    };
  }
}
