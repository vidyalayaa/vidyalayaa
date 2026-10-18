import pg from 'pg';
import type { Config } from './config.js';
export type Tx = Pick<pg.PoolClient, 'query'>;
export interface TenantContext {
  schoolId: string;
  userId?: string;
  actorType?: 'USER' | 'DEVICE' | 'SYSTEM' | 'SUPPORT';
  requestId?: string;
}
export function makePool(
  url: string,
  config: Pick<Config, 'DB_SSL' | 'DB_CA_CERT' | 'DB_POOL_SIZE'>,
) {
  return new pg.Pool({
    connectionString: url,
    max: config.DB_POOL_SIZE,
    ssl:
      config.DB_SSL === 'true'
        ? {
            rejectUnauthorized: true,
            ...(config.DB_CA_CERT ? { ca: config.DB_CA_CERT.replace(/\\n/g, '\n') } : {}),
          }
        : false,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    application_name: 'vidyalayaa',
  });
}
export async function transaction<T>(
  pool: pg.Pool,
  ctx: TenantContext,
  fn: (tx: Tx) => Promise<T>,
  readOnly = false,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    await c.query(
      "SELECT set_config('app.school_id',$1,true),set_config('app.user_id',$2,true),set_config('app.actor_type',$3,true),set_config('app.request_id',$4,true),set_config('lock_timeout','5s',true),set_config('statement_timeout','30s',true)",
      [ctx.schoolId, ctx.userId || '', ctx.actorType || 'USER', ctx.requestId || ''],
    );
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
export async function platformTx<T>(pool: pg.Pool, userId: string, fn: (tx: Tx) => Promise<T>) {
  return transaction(pool, { schoolId: '', userId }, fn);
}
export async function audit(
  tx: Tx,
  schoolId: string,
  userId: string,
  action: string,
  entity: string,
  id?: string,
) {
  await tx.query(
    "INSERT INTO audit_logs(school_id,actor_type,actor_id,action,entity_type,entity_id) VALUES($1,'USER',$2,$3,$4,$5)",
    [schoolId, userId, action, entity, id || null],
  );
}
