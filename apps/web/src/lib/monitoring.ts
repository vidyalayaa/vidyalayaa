import * as Sentry from '@sentry/react';
if (import.meta.env.VITE_SENTRY_DSN)
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_RELEASE,
    defaultIntegrations: false,
    sendDefaultPii: false,
    beforeSend(event) {
      return {
        type: event.type,
        event_id: event.event_id,
        timestamp: event.timestamp,
        level: event.level,
        platform: event.platform,
        environment: event.environment,
        release: event.release,
        exception: {
          values: event.exception?.values?.map((v) => ({
            type: v.type,
            value: 'A workspace view could not be rendered',
            stacktrace: {
              frames: v.stacktrace?.frames?.map((f) => ({
                filename: f.filename?.split('?')[0].split('#')[0],
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
export function captureRenderFailure(error: Error) {
  if (import.meta.env.VITE_SENTRY_DSN) Sentry.captureException(error);
}
