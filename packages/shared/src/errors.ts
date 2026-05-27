declare interface ErrorConstructorV8 extends ErrorConstructor {
  captureStackTrace(target: object, constructorOpt?: Function): void;
}

export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly details?: Array<{ field?: string; message: string }>,
  ) {
    super(message);
    this.name = this.constructor.name;
    if ('captureStackTrace' in Error) {
      (Error as unknown as ErrorConstructorV8).captureStackTrace(this, this.constructor);
    }
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details && { details: this.details }),
      },
    };
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super(
      id ? `${resource} not found: ${id}` : `${resource} not found`,
      404,
      'not_found',
    );
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'unauthorized');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Access denied') {
    super(message, 403, 'forbidden');
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Array<{ field?: string; message: string }>) {
    super(message, 409, 'conflict', details);
  }
}

export class ValidationError extends AppError {
  constructor(details: Array<{ field: string; message: string }>) {
    super('Validation failed', 400, 'validation_error', details);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(service: string, message?: string) {
    super(
      message || `${service} is unavailable`,
      503,
      'service_unavailable',
    );
  }
}
