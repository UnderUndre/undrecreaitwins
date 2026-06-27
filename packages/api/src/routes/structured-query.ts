import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { LLMClient, groundingEngine } from '@undrecreaitwins/core/services/index.js';
import { PersonaRepository } from '@undrecreaitwins/core/services/persona-repository.js';
import { ValidationError, NotFoundError } from '@undrecreaitwins/shared';

const repo = new PersonaRepository();
const llm = new LLMClient();

const structuredQuerySchema = z.object({
  systemPrompt: z.string().min(1),
  userInstruction: z.string().optional(),
  responseFormat: z.object({
    type: z.enum(['json_object']),
  }).optional(),
  maxTokens: z.number().int().positive().optional(),
});

export const structuredQueryRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/v1/personas/:personaId/structured-query', async (request) => {
    const { personaId } = request.params as { personaId: string };

    // Validate persona exists and belongs to tenant
    try {
      await repo.getById(request.tenantId, personaId);
    } catch {
      throw new NotFoundError('Persona', personaId);
    }

    const parseResult = structuredQuerySchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      );
    }

    const body = parseResult.data;

    // Calls groundingEngine.query('', tenantId, personaId) for document text
    const chunks = await groundingEngine.query('', request.tenantId, personaId);

    // Join chunks / document text
    const docText = chunks.map(c => c.text).join('\n---\n');

    // Compose messages array. Docs ALWAYS in user role per contract
    const messages = [
      { role: 'system', content: body.systemPrompt },
      { role: 'user', content: `${body.userInstruction ?? ''}\n\n<documents>\n${docText}` },
    ];

    // Calls llm.complete
    const response = await llm.complete({
      messages,
      responseFormat: body.responseFormat,
      maxTokens: body.maxTokens ?? 8000,
      tenantId: request.tenantId,
      personaId,
    });

    return {
      content: response.content,
      usage: {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
      },
    };
  });
};
