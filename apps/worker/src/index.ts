import { assertRuntimeRole } from '../../api/src/lib/runtime-role.js';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { makePool } from '../../api/src/lib/db.js';
import { drainOutbox } from './outbox.js';
import { scheduledJobs } from './jobs.js';
import { reconcileEvents } from './reconcile.js';
import { generateReports } from './reports.js';
import { monitorWorker } from './health.js';
import {applyRetention} from './retention.js';
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
      const schools = (
        await pool.query<{ worker_schools: string }>('SELECT app.worker_schools()')
      ).rows.map((x) => x.worker_schools);
      for (const school of schools) {
        if (stopping) break;
        try {
          await drainOutbox(pool, school, env.TOKEN_ENCRYPTION_KEY);
          await generateReports(pool, school, storage);
          if (Date.now() - lastJobs >= 60000) {
            await scheduledJobs(pool, school);
            await reconcileEvents(pool, school);
            await applyRetention(pool,school,storage);
          }
        } catch {
          ok = false;
          console.error(
            JSON.stringify({
              level: 'error',
              code: 'WORKER_SCHOOL_CYCLE_FAILED',
              school_id: school,
            }),
          );
        }
      }
      if (Date.now() - lastJobs >= 60000) lastJobs = Date.now();
    } catch {
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
