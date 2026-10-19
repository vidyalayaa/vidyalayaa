import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export const notFound = () => new ApiError(404, 'NOT_FOUND', 'The requested record was not found.');
export const asyncRoute =
  (fn: RequestHandler): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const request_id = String(res.locals.requestId || '');
  if (err instanceof ZodError) {
    res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Check the supplied fields.',
        details: err.flatten(),
        issues: err.issues.map((i) => ({ path: i.path, message: i.message })),
      },
      request_id,
      server_time: new Date().toISOString(),
    });
    return;
  }
  if (err?.type === 'entity.too.large') {
    res.status(413).json({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds the endpoint limit.' },
      request_id,
      server_time: new Date().toISOString(),
    });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({
      error: { code: 'BAD_REQUEST', message: 'Invalid JSON.' },
      request_id,
      server_time: new Date().toISOString(),
    });
    return;
  }
  const dbCode = err?.code as string | undefined;
  const knownConstraint =
    dbCode === '23514' &&
    (
      {
        LAST_SCHOOL_ADMIN:
          'Add another active School Admin before changing the last administrator.',
        INVITATION_PENDING:
          'The person must accept a school invitation before access can be activated.',
      } as Record<string, string>
    )[err.message];
  if (knownConstraint) {
    res.status(409).json({
      error: { code: err.message, message: knownConstraint },
      request_id,
      server_time: new Date().toISOString(),
    });
    return;
  }
  const status =
    err instanceof ApiError
      ? err.status
      : ['23503', '23505', '23514', '23P01'].includes(dbCode || '')
        ? 409
        : 500;
  const code =
    err instanceof ApiError ? err.code : status === 409 ? 'CONSTRAINT_CONFLICT' : 'INTERNAL';
  if (status === 500) req.log.error({ error_code: dbCode, request_id }, 'Request failed');
  res.status(status).json({
    error: {
      code,
      ...(err instanceof ApiError && err.details ? { details: err.details } : {}),
      message:
        err instanceof ApiError
          ? err.message
          : status === 409
            ? 'This change conflicts with existing records or constraints.'
            : 'The request could not be completed.',
    },
    request_id,
    server_time: new Date().toISOString(),
  });
};
