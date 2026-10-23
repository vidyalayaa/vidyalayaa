import { captureFailure } from './monitoring.js';
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
  if (err?.type === 'entity.too.large' || err?.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds the endpoint limit.' },
      request_id,
      server_time: new Date().toISOString(),
    });
    return;
  }
  if (err?.name === 'MulterError') {
    res.status(422).json({
      error: {
        code: 'INVALID_UPLOAD',
        message: 'Upload one image and one manifest within the documented limits.',
      },
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
  if (dbCode === '28000' && err.message === 'SESSION_EXPIRED') {
    res
      .status(401)
      .json({
        error: { code: 'SESSION_ENDED', message: 'This login session has ended. Sign in again.' },
        request_id,
        server_time: new Date().toISOString(),
      });
    return;
  }
  const knownConstraint =
    dbCode === '23514' &&
    (
      {
        DEVICE_SYNC_REQUIRED:
          'Synchronize every active reader and clear its pending queue before closing the school.',
        OFFBOARDING_APPROVAL_REQUIRED:
          'A different School Admin must approve the closure and an export window must remain open.',
        ENTERPRISE_REQUIRED: 'This school needs an active Enterprise campus entitlement.',
        CAMPUS_LIMIT_REACHED: 'The organization has reached a participating school campus limit.',
        LAST_SCHOOL_ADMIN:
          'Add another active School Admin before changing the last administrator.',
        INVITATION_PENDING:
          'The person must accept a school invitation before access can be activated.',
        TIMETABLE_ASSIGNMENT_INVALID:
          'Choose an active subject teacher assigned to this class and section.',
        TIMETABLE_PERIOD_INVALID: 'Choose a configured school day and lecture period.',
        TIMETABLE_TIMINGS_INVALID:
          'School timings contain invalid or overlapping lectures or breaks.',
        TIMETABLE_VERSION_CONFLICT: 'School timings changed. Refresh before saving again.',
        FEE_HISTORY_IMMUTABLE:
          'Posted fee history is immutable. Reverse payments or void unpaid assessments, then create a corrected record.',
        FEE_LEDGER_REQUIRED:
          'Paid totals and installment status are calculated from the payment ledger.',
        FEE_CLASS_INVALID: 'Choose a class and enrollment in the selected academic year.',
        FEE_TRANSPORT_INVALID: 'Check the transport assignment, dates and fee amount.',
        FEE_TRANSPORT_REQUIRED: 'Assign a transport service before charging transport fees.',
        FEE_STRUCTURE_INVALID: 'Check the class fee structure, section mode and due dates.',
        FEE_ALLOCATION_INVALID:
          'A selected installment has changed or its balance is insufficient. Refresh the fee statement.',
        FEE_PAYMENT_INVALID: 'Check the payment date, account and retry key.',
        FEE_PAYMENT_UNBALANCED: 'Payment allocations must equal the receipt total.',
        FEE_PAYMENT_REVERSED: 'This payment was already reversed.',
        FEE_REFERENCE_REQUIRED: 'Enter a transaction or cheque reference for this payment method.',
        FEE_RECEIPT_INVALID:
          'Use letters, numbers, hyphens, underscores or slashes in the receipt number.',
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
  if (status === 500) captureFailure(err, dbCode || 'INTERNAL', request_id);
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
