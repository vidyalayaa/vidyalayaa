import { makePool } from '../../api/src/lib/db.js';
import { assertRuntimeRole } from '../../api/src/lib/runtime-role.js';
const pool = makePool(process.env.WORKER_DATABASE_URL || '', {
  DB_SSL: process.env.DB_SSL === 'false' ? 'false' : 'true',
  DB_CA_CERT: process.env.DB_CA_CERT,
  DB_POOL_SIZE: 1,
});
try {
  await assertRuntimeRole(pool, 'app_worker');
  const ready = process.argv.includes('--ready');
  const result = await pool.query(
    `SELECT EXISTS(SELECT FROM worker_instances WHERE last_seen_at>now()-interval '90 seconds' AND state<>'STOPPING' ${ready ? "AND last_success_at>now()-interval '5 minutes' AND state='RUNNING'" : ''}) AS healthy`,
  );
  if (!result.rows[0].healthy) throw new Error('WORKER_NOT_READY');
  console.log(ready ? 'Worker ready' : 'Worker alive');
} catch {
  console.error('Worker health check failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
