import { FastifyInstance } from 'fastify';
import { documentService } from '@undrecreaitwins/core/services/index.js';
import { AppError } from '@undrecreaitwins/shared';

export const documentRoutes = async (fastify: FastifyInstance) => {
  // T019: POST upload with bodyLimit 10MB (gemini F4)
  fastify.post('/v1/assistants/:id/documents', {
    bodyLimit: 10 * 1024 * 1024,
  }, async (request) => {
    const { id } = request.params as { id: string };
    
    const data = await request.file();
    if (!data) throw new AppError('No file uploaded', 400, 'bad_request');

    const allowedMimeTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain'
    ];

    if (!allowedMimeTypes.includes(data.mimetype)) {
      throw new AppError(`Invalid file type: ${data.mimetype}`, 400, 'bad_request');
    }

    const buffer = await data.toBuffer();
    if (buffer.length > 10 * 1024 * 1024) {
      throw new AppError('File too large (max 10MB)', 400, 'bad_request');
    }

    const result = await documentService.ingest(request.tenantId, id, {
      filename: data.filename,
      mimeType: data.mimetype,
      buffer,
    });

    return { id: result.documentId };
  });

  fastify.get('/v1/assistants/:id/documents', async (request) => {
    const { id } = request.params as { id: string };
    return documentService.list(request.tenantId, id);
  });

  fastify.delete('/v1/documents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await documentService.delete(request.tenantId, id);
    reply.status(204);
  });
};
