import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import {
  AppError,
  InternalError,
  normalizeError,
  RateLimitError,
  toErrorResponse,
  ValidationError,
  type FieldIssue,
} from '@wallet/errors';
import type { Logger } from '@wallet/logger';

/**
 * The ONE place an error response is built (prompt_phase1.md rule 85).
 *
 * No route formats its own error. That is what makes the error contract in
 * @wallet/types true rather than aspirational, and it is why a client can
 * safely switch on `error.code`.
 */
export function registerErrorHandler(app: FastifyInstance, logger: Logger): void {
  app.setErrorHandler((raw: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const error = toAppError(raw);
    const correlationId = request.correlationId;

    // Internal detail goes here — to the logs — and only here (rule 84).
    // Note the fields: codes and names, never messages from a driver, because
    // those routinely carry connection strings and query text.
    const fields = {
      errorCode: error.code,
      errorName: error.name,
      isOperational: error.isOperational,
      statusCode: error.httpStatus,
      route: request.routeOptions.url ?? request.url,
      method: request.method,
    };

    if (error.isOperational) {
      logger.warn('request failed', fields);
    } else {
      // Not operational means "a bug", and a bug is worth the stack in the
      // logs — where a human looks — rather than in the response.
      logger.error('request failed unexpectedly', fields);
      if (raw instanceof Error && raw.stack !== undefined) {
        logger.error('stack', { errorName: raw.name, reason: firstStackLine(raw) });
      }
    }

    if (error instanceof RateLimitError) {
      void reply.header('retry-after', String(error.retryAfterSeconds));
    }

    void reply.status(error.httpStatus).send(toErrorResponse(error, correlationId));
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send(
      toErrorResponse(
        new (class extends AppError {
          readonly code = 'NOT_FOUND' as const;
          readonly httpStatus = 404;
        })('Not found'),
        request.correlationId,
      ),
    );
  });
}

function toAppError(raw: FastifyError): AppError {
  // Zod schema failures from fastify-type-provider-zod arrive as Fastify
  // validation errors; unwrap them into the shared ValidationError so the body
  // shape matches every other 400.
  if (hasZodFastifySchemaValidationErrors(raw)) {
    const fields: FieldIssue[] = raw.validation.map((issue) => ({
      path: issue.params.issue.path.join('.') || '(root)',
      message: issue.params.issue.message,
    }));
    return new ValidationError(fields);
  }

  // Fastify's own errors (payload too large, unsupported media type, malformed
  // JSON) carry a statusCode but not our contract.
  if (typeof raw.statusCode === 'number' && raw.statusCode < 500) {
    if (
      raw.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ||
      raw.code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
    ) {
      return new ValidationError([{ path: '(body)', message: 'Malformed request body' }]);
    }
  }

  return normalizeError(raw) as AppError;
}

function firstStackLine(error: Error): string {
  return (error.stack ?? '').split('\n')[1]?.trim().slice(0, 200) ?? 'no stack';
}

export { InternalError };
