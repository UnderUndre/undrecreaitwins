import type { FastifyReply, FastifyRequest } from 'fastify';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}


export class BadRequestError extends AppError {
  constructor(message: string) {
    super(400, 'BAD_REQUEST', message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string) {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class UpstreamError extends AppError {
  constructor(message: string) {
    super(502, 'UPSTREAM_ERROR', message);
  }
}

export class CircuitOpenError extends AppError {
  constructor(message: string) {
    super(503, 'CIRCUIT_OPEN', message);
  }
}

export class RateLimitedError extends AppError {
  constructor(message: string) {
    super(503, 'RATE_LIMITED', message);
  }
}

export class GatewayTimeoutError extends AppError {
  constructor(message: string) {
    super(504, 'GATEWAY_TIMEOUT', message);
  }
}

export const errorHandler = (
  error: Error,
  request: FastifyRequest,
  reply: FastifyReply
) => {
  const logger = request.log;

  if (error instanceof AppError) {
    // Set headers if needed, e.g. Retry-After for 503
    if (error instanceof CircuitOpenError) {
      reply.header('Retry-After', '30');
    } else if (error instanceof RateLimitedError) {
      reply.header('Retry-After', '1');
    }

    // Do not log user inputs/documents in error logging.
    logger.error({
      err: {
        name: error.name,
        code: error.code,
        message: error.message,
        stack: error.stack,
      }
    }, 'Application error occurred');

    return reply.status(error.statusCode).send({
      error: error.code,
      message: error.message,
    });
  }

  // Handle Zod validation errors
  if (error.name === 'ZodError') {
    logger.warn({ err: error }, 'Validation error');
    return reply.status(400).send({
      error: 'BAD_REQUEST',
      message: error.message,
    });
  }

  // Handle syntax/parsing errors
  if (error instanceof SyntaxError) {
    logger.warn({ err: error }, 'Syntax/parsing error');
    return reply.status(400).send({
      error: 'BAD_REQUEST',
      message: 'Malformed request payload',
    });
  }

  // Fallback for unhandled native/other errors
  logger.error({ err: error }, 'Unhandled server error');
  return reply.status(500).send({
    error: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected error occurred',
  });
};
