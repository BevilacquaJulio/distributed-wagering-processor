import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import { ZodError } from 'zod';
import { ApplicationError } from '../application/errors';
import { DomainError, InvalidMoneyError } from '../domain/errors';
import { logEvent, Metrics, requestContext } from '../infrastructure/observability';
import { isUnavailable } from '../infrastructure/postgres/unit-of-work';

interface ErrorResponse { status(status: number): ErrorResponse; json(body: unknown): void; }

export class InvalidRequest extends Error {
  constructor(public readonly code: 'INVALID_PAYLOAD' | 'MISSING_IDEMPOTENCY_KEY') { super(code); }
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(private readonly metrics: Metrics) {}
  catch(error: unknown, host: ArgumentsHost): void {
    let status = 500;
    let code = 'INTERNAL_ERROR';
    if (error instanceof ApplicationError) {
      code = error.code;
      status = code === 'INFRASTRUCTURE_UNAVAILABLE' ? 503
        : code.endsWith('NOT_FOUND') ? 404 : 409;
    } else if (error instanceof DomainError) {
      code = error.code;
      status = 422;
    } else if (error instanceof InvalidRequest || error instanceof ZodError || error instanceof InvalidMoneyError) {
      code = error instanceof InvalidRequest ? error.code : 'INVALID_PAYLOAD';
      status = 400;
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      code = status === 404 ? 'RESOURCE_NOT_FOUND' : status === 413 ? 'PAYLOAD_TOO_LARGE'
        : status === 503 ? 'INFRASTRUCTURE_UNAVAILABLE' : status >= 500 ? 'INTERNAL_ERROR' : 'INVALID_PAYLOAD';
    } else if (typeof error === 'object' && error !== null && 'type' in error &&
      (error.type === 'entity.parse.failed' || error.type === 'entity.too.large')) {
      status = error.type === 'entity.too.large' ? 413 : 400;
      code = status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_PAYLOAD';
    } else if (isUnavailable(error)) {
      status = 503;
      code = 'INFRASTRUCTURE_UNAVAILABLE';
    }
    logEvent('request_failed', { code, status });
    if (status === 409) this.metrics.increment('conflict');
    if (status === 503) this.metrics.increment('infrastructure_failure');
    host.switchToHttp().getResponse<ErrorResponse>().status(status).json({
      error: { code, message: code, requestId: requestContext.getStore()?.correlationId ?? null },
    });
  }
}
