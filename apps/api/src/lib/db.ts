import pg from 'pg';
import { rootCertificates } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
export type Tx = Pick<pg.PoolClient, 'query'>;
export interface TenantContext {
  schoolId: string;
  userId?: string;
  actorType?: 'USER' | 'DEVICE' | 'SYSTEM' | 'SUPPORT';
  requestId?: string;
  parentChildId?: string;
}
const SUPABASE_ROOT_2021_CA = `-----BEGIN CERTIFICATE-----
MIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL
BQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l
dyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh
c2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow
azELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD
YXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug
Um9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW
QyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q
DmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2
GtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi
cvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4
O4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt
NaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX
uXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt
aUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU
tVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b
VW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6
jB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx
Cea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2
CMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P
o/bKiIz+Fq8=
-----END CERTIFICATE-----`;

type DatabaseTlsConfig = Pick<Config, 'DB_SSL' | 'DB_CA_CERT'> & {
  DB_SSL_REJECT_UNAUTHORIZED?: 'true' | 'false';
};

/** Keep URL SSL parameters from replacing the verified TLS options in node-postgres. */
export function databaseConnectionOptions(url: string, config: DatabaseTlsConfig): pg.ClientConfig {
  if (
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
    process.env.DB_SSL_REJECT_UNAUTHORIZED === 'false' ||
    config.DB_SSL_REJECT_UNAUTHORIZED === 'false'
  )
    throw new Error(
      'Database certificate verification must stay enabled. Remove NODE_TLS_REJECT_UNAUTHORIZED=0 and DB_SSL_REJECT_UNAUTHORIZED=false; configure DB_CA_CERT instead.',
    );
  if (process.env.NODE_ENV === 'production' && config.DB_SSL !== 'true')
    throw new Error('Verified database TLS is mandatory in production.');

  let connection: URL;
  try {
    connection = new URL(url);
    if (!['postgres:', 'postgresql:'].includes(connection.protocol)) throw new Error();
  } catch {
    // URL parser errors can include the password-bearing input.
    throw new Error('Invalid database connection URL. Use a PostgreSQL connection URL.');
  }
  const host = (connection.searchParams.get('host') || connection.hostname)
    .toLowerCase()
    .replace(/\.$/, '');
  for (const key of [
    'ssl',
    'sslmode',
    'sslcert',
    'sslkey',
    'sslrootcert',
    'sslnegotiation',
    'uselibpqcompat',
  ])
    connection.searchParams.delete(key);

  const rawCa = config.DB_CA_CERT?.trim();
  const customCa = rawCa
    ? rawCa.replace(/^["']|["']$/g, '').replace(/\\r\\n|\\n/g, '\n')
    : undefined;
  if (customCa) {
    const pem = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
    const certificates = customCa.match(pem);
    try {
      if (!certificates?.length || customCa.replace(pem, '').trim()) throw new Error();
      for (const certificate of certificates) new X509Certificate(certificate);
    } catch {
      throw new Error(
        'DB_CA_CERT must contain complete PEM certificates. Replace it with the database CA certificate, or remove it to use the built-in Supabase trust roots.',
      );
    }
  }
  // A custom certificate must not remove Supabase's trusted roots. A copied or
  // stale provider certificate otherwise causes SELF_SIGNED_CERT_IN_CHAIN.
  const ca = /\.(supabase\.co|supabase\.com)$/.test(host)
    ? [...rootCertificates, SUPABASE_ROOT_2021_CA, ...(customCa ? [customCa] : [])]
    : customCa;
  return {
    connectionString: connection.toString(),
    ssl:
      config.DB_SSL === 'true'
        ? {
            rejectUnauthorized: true,
            ...(ca ? { ca } : {}),
          }
        : false,
    connectionTimeoutMillis: 5000,
    application_name: 'vidyalayaa',
  };
}

export function makePool(url: string, config: DatabaseTlsConfig & Pick<Config, 'DB_POOL_SIZE'>) {
  return new pg.Pool({
    ...databaseConnectionOptions(url, config),
    max: config.DB_POOL_SIZE,
    idleTimeoutMillis: 30000,
  });
}
export async function transaction<T>(
  pool: pg.Pool,
  ctx: TenantContext,
  fn: (tx: Tx) => Promise<T>,
  readOnly = false,
  isolation: 'read committed' | 'repeatable read' = 'read committed',
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query(
      isolation === 'repeatable read'
        ? readOnly
          ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
          : 'BEGIN ISOLATION LEVEL REPEATABLE READ'
        : readOnly
          ? 'BEGIN READ ONLY'
          : 'BEGIN',
    );
    await c.query(
      "SELECT set_config('app.school_id',$1,true),set_config('app.user_id',$2,true),set_config('app.actor_type',$3,true),set_config('app.request_id',$4,true),set_config('app.parent_child_id',$5,true),set_config('app.notification_protocol','custom-v1',true),set_config('lock_timeout','5s',true),set_config('statement_timeout','30s',true)",
      [
        ctx.schoolId,
        ctx.userId || '',
        ctx.actorType || 'USER',
        ctx.requestId || '',
        ctx.parentChildId || '',
      ],
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
export async function lockSchoolLifecycle(tx: Tx, schoolId: string, exclusive = false) {
  await tx.query(
    `SELECT ${exclusive ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared'}(hashtextextended($1::text||':school-lifecycle',0))`,
    [schoolId],
  );
}
export async function lockSchoolStorageWrite(tx: Tx, schoolId: string, finalExport = false) {
  await lockSchoolLifecycle(tx, schoolId);
  const available = await tx.query(
    `SELECT s.id FROM schools s WHERE s.id=$1 AND s.status<>'TERMINATED'
     AND NOT EXISTS(SELECT FROM school_offboarding o WHERE o.school_id=s.id
       AND o.permanent AND o.status IN ('CLOSED','PURGE_REQUESTED','PURGING')
       AND (NOT $2::boolean OR o.irreversible_at IS NOT NULL))`,
    [schoolId, finalExport],
  );
  if (!available.rowCount)
    throw new ApiError(409, 'SCHOOL_OFFBOARDED', 'This school can no longer receive these files.');
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
