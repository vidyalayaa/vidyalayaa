import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { deliver, DeliveryError } from './providers.js';

export async function sendLoginAlerts(pool: pg.Pool) {
  // Keep in-app alerts even when outbound email isn't configured.
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return;
  const lease = randomUUID();
  const jobs = (
    await pool.query<{ id: string; email: string; login_at: Date }>(
      'SELECT * FROM app.claim_login_alerts($1)',
      [lease],
    )
  ).rows;
  for (const job of jobs) {
    let sent = false,
      permanent = false;
    try {
      const time = new Date(job.login_at).toISOString();
      await deliver(
        'EMAIL',
        job.email,
        `A new login to your Vidyalayaa account was detected at ${time}. If this was not you, open Settings → Security & Login Sessions to end unfamiliar sessions, then change your password. Vidyalayaa will never ask for your password or verification code by email.`,
        'login-alert-' + job.id,
      );
      sent = true;
    } catch (error) {
      permanent = error instanceof DeliveryError && error.permanent;
    }
    await pool.query('SELECT app.finish_login_alert($1,$2,$3,$4)', [
      job.id,
      lease,
      sent,
      permanent,
    ]);
  }
}
