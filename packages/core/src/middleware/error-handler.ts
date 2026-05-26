import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '@undrecreaitwins/shared';

export function errorHandler(
  error: FastifyError | AppError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send(error.toJSON());
  }

  if ('statusCode' in error && typeof error.statusCode === 'number') {
    return reply.status(error.statusCode).send({
      error: {
        code: 'request_error',
        message: error.message,
      },
    });
  }

  request.log.error({ err: error }, 'Unhandled error');
  return reply.status(500).send({
    error: {
      code: 'internal_error',
      message: 'Internal server error',
    },
  });
}
