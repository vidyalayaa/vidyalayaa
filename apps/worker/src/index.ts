import { forSchools } from './concurrency.js';
import { captureFailure } from '../../api/src/lib/monitoring.js';
import { assertRuntimeRole } from '../../api/src/lib/runtime-role.js';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { makePool, transaction } from '../../api/src/lib/db.js';
import { drainOutbox } from './outbox.js';
import { scheduledJobs } from './jobs.js';
import { reconcileEvents } from './reconcile.js';
import { generateReports } from './reports.js';
import { monitorWorker } from './health.js';
import { purgeApprovedSchool } from './offboarding.js';
import { generateSchoolExport } from './school-exports.js';
import { applyRetention } from './retention.js';
import { sendLoginAlerts } from './login-alerts.js';
const env = z
  .object({
    WORKER_DATABASE_URL: z.string().min(1),
    SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    TOKEN_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
    DB_SSL: z.enum(['true', 'false']).default('true'),
    DB_CA_CERT: z.string().optional(),
    DB_POOL_SIZE: z.coerce.number().default(5),
  })
  .parse(process.env);
if (process.env.NODE_ENV === 'production' && env.DB_SSL !== 'true')
  throw new Error('Verified database TLS is mandatory in production.');
const pool = makePool(env.WORKER_DATABASE_URL, env),
  storage = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
let stopping = false,
  lastJobs = 0;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopping = true;
  });
async function run() {
  const health = await monitorWorker(pool);
  while (!stopping) {
    let ok = true;
    try {
      await sendLoginAlerts(pool);
      if (Date.now() - lastJobs >= 60000)
        await pool.query('SELECT app.prune_account_security_events()');
      const schools = (
        await pool.query<{ worker_schools: string }>('SELECT app.worker_schools()')
      ).rows.map((x) => x.worker_schools);
      await forSchools(
        schools,
        Math.max(1, Math.min(3, Math.floor(env.DB_POOL_SIZE / 2))),
        async (school) => {
          if (stopping) return;
          try {
            const closed = await transaction(
              pool,
              { schoolId: school, actorType: 'SYSTEM' },
              async (tx) =>
                (
                  await tx.query(
                    "SELECT id FROM school_offboarding WHERE school_id=$1 AND status IN ('CLOSED','PURGE_REQUESTED','PURGING','PURGED')",
                    [school],
                  )
                ).rowCount! > 0,
              true,
            );
            if (!closed) await drainOutbox(pool, school, env.TOKEN_ENCRYPTION_KEY);
            if (!closed) await generateReports(pool, school, storage);
            await generateSchoolExport(pool, school, storage);
            await purgeApprovedSchool(pool, school, storage);
            if (!closed && Date.now() - lastJobs >= 60000) {
              await scheduledJobs(pool, school);
              await reconcileEvents(pool, school);
              await applyRetention(pool, school, storage);
            }
          } catch (error) {
            captureFailure(error, 'WORKER_SCHOOL_CYCLE_FAILED');
            ok = false;
            console.error(
              JSON.stringify({
                level: 'error',
                code: 'WORKER_SCHOOL_CYCLE_FAILED',
                school_id: school,
              }),
            );
          }
        },
      );
      if (Date.now() - lastJobs >= 60000) lastJobs = Date.now();
    } catch (error) {
      captureFailure(error, 'WORKER_CYCLE_FAILED');
      ok = false;
      console.error(
        JSON.stringify({
          level: 'error',
          code: 'WORKER_CYCLE_FAILED',
          time: new Date().toISOString(),
        }),
      );
    }
    await health.cycle(ok).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  await health.stop().catch(() => {});
  await pool.end();
}
await assertRuntimeRole(pool, 'app_worker').catch(async () => {
  await pool.end();
  throw new Error('WORKER_DATABASE_ROLE_VALIDATION_FAILED');
});
run().catch(() => {
  process.exitCode = 1;
});
