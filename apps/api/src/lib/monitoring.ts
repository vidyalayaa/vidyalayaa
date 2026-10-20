import * as Sentry from '@sentry/node';

if (process.env.SENTRY_DSN)
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    release: process.env.RENDER_GIT_COMMIT,
    defaultIntegrations: false,
    sendDefaultPii: false,
    beforeSend(event) {
      // Explicit allowlist: no request bodies, cookies, headers, URLs, user profiles or breadcrumbs.
      return {
        type: event.type,
        event_id: event.event_id,
        timestamp: event.timestamp,
        level: event.level,
        platform: event.platform,
        environment: event.environment,
        release: event.release,
        tags: event.tags,
        exception: {
          values: event.exception?.values?.map((v) => ({
            type: v.type,
            value: 'Application operation failed',
            stacktrace: {
              frames: v.stacktrace?.frames?.map((f) => ({
                filename: f.filename?.split('?')[0],
                function: f.function,
                lineno: f.lineno,
                colno: f.colno,
              })),
            },
          })),
        },
      };
    },
  });
export function captureFailure(error: unknown, code: string, requestId?: string) {
  if (!process.env.SENTRY_DSN) return;
  Sentry.withScope((scope) => {
    scope.setTag('error_code', code);
    if (requestId) scope.setTag('request_id', requestId);
    Sentry.captureException(error);
  });
}
