import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AnnotationService, langfuseService, embeddingService } from '@undrecreaitwins/core/services/index.js';

export const annotationRoutes = async (fastify: FastifyInstance) => {
  const service = new AnnotationService(embeddingService);

  fastify.post('/v1/assistants/:id/annotations', async (request) => {
    const { id } = request.params as { id: string };
    const bodySchema = z.object({
      original_query: z.string().min(1),
      bad_response: z.string().min(1),
      corrected_response: z.string().min(1),
    });

    const data = bodySchema.parse(request.body);
    
    // US1: Push to Langfuse dataset (FR-012)
    const datasetItemId = await langfuseService.pushToDataset('corrections', {
      input: data.original_query,
      output: data.corrected_response,
      metadata: { 
        personaId: id, 
        tenantId: request.tenantId,
        badResponse: data.bad_response 
      },
    });

    const annotationId = await service.upsert(request.tenantId, {
      personaId: id,
      originalQuery: data.original_query,
      badResponse: data.bad_response,
      correctedResponse: data.corrected_response,
    });

    return { id: annotationId, langfuse_dataset_item_id: datasetItemId };
  });

  fastify.delete('/v1/annotations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await service.delete(request.tenantId, id);
    reply.status(204);
  });
};
