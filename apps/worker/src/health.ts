import { randomUUID } from 'node:crypto';
import type pg from 'pg';
export async function monitorWorker(pool: pg.Pool) {
  const id = process.env.WORKER_INSTANCE_ID || randomUUID();
  let state = 'STARTING',
    success: Date | null = null,
    error: string | null = null,
    writing = false;
  const beat = async () => {
    if (writing) return;
    writing = true;
    try {
      await pool.query(
        'INSERT INTO worker_instances(id,state,last_success_at,last_error_code) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET last_seen_at=now(),state=$2,last_success_at=$3,last_error_code=$4',
        [id, state, success, error],
      );
    } finally {
      writing = false;
    }
  };
  await beat();
  const timer = setInterval(
    () =>
      beat().catch(() =>
        console.error(JSON.stringify({ level: 'error', code: 'WORKER_HEARTBEAT_FAILED' })),
      ),
    30000,
  );
  timer.unref();
  return {
    async cycle(ok: boolean) {
      state = ok ? 'RUNNING' : 'DEGRADED';
      if (ok) success = new Date();
      error = ok ? null : 'WORKER_CYCLE_FAILED';
      await beat();
    },
    async stop() {
      clearInterval(timer);
      state = 'STOPPING';
      await beat();
    },
  };
}
