import { afterEach, expect, it, vi } from 'vitest';
import pg from 'pg';
import type { ConnectionOptions } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { databaseConnectionOptions, makePool } from '../../apps/api/src/lib/db';

const config = { DB_SSL: 'true' as const, DB_POOL_SIZE: 1 };
const connection = 'postgresql://fixture:password@db.fixture.supabase.co:5432/postgres';
function effectiveTls(url: string, ca?: string) {
  const client = new pg.Client(databaseConnectionOptions(url, { ...config, DB_CA_CERT: ca }));
  // Exercise the installed driver's URL parsing, where the regression occurred.
  return (client as unknown as { connectionParameters: { ssl: ConnectionOptions } })
    .connectionParameters.ssl;
}
afterEach(() => vi.unstubAllEnvs());

it.each(['require', 'verify-full', 'verify-ca', 'no-verify', 'disable'])(
  'preserves verified TLS and the Supabase CA when the URL contains sslmode=%s',
  (mode) => {
    const tls = effectiveTls(`${connection}?sslmode=${mode}`);
    expect(tls.rejectUnauthorized).toBe(true);
    const ca = tls.ca as string[];
    expect(ca.length).toBeGreaterThan(1);
    const root = new X509Certificate(ca.at(-1)!);
    expect(root.subject).toContain('Supabase Root 2021 CA');
    expect(root.ca).toBe(true);
  },
);

it('strips conflicting URL SSL options before the driver can load files or override verification', () => {
  const url = `${connection}?sslmode=require&sslmode=disable&ssl=no-verify&sslrootcert=/missing/ca&sslcert=/missing/cert&sslkey=/missing/key&sslnegotiation=direct&uselibpqcompat=true&application_name=deployment-check`;
  const options = databaseConnectionOptions(url, config);
  expect(new URL(options.connectionString!).searchParams.toString()).toBe(
    'application_name=deployment-check',
  );
  expect(effectiveTls(url).rejectUnauthorized).toBe(true);
});

it('accepts real multiline or escaped CA PEM without losing it to URL parameters', () => {
  const ca = (effectiveTls(connection).ca as string[]).at(-1)!;
  for (const configured of [ca, `"${ca.replaceAll('\n', '\\n')}"`, ca.replaceAll('\n', '\\r\\n')]) {
    const tls = effectiveTls(`${connection}?sslmode=require`, configured);
    expect(tls.ca).toBe(ca);
    expect(tls.rejectUnauthorized).toBe(true);
  }
});

it('uses standard trusted roots for other providers and never selects a CA from credentials', () => {
  const tls = effectiveTls('postgresql://supabase.co:fixture@other-provider.example/postgres');
  expect(tls.rejectUnauthorized).toBe(true);
  expect(tls.ca).toBeUndefined();
  expect(effectiveTls(connection + '?host=other-provider.example').ca).toBeUndefined();
  expect(
    effectiveTls(connection.replace('supabase.co', 'supabase.co.evil.test')).ca,
  ).toBeUndefined();
});

it('preserves percent-encoded login credentials, database and unrelated URL options', () => {
  const url =
    'postgresql://fixture:p%40ss%2Fword%3F%23@db.fixture.supabase.co:5432/school?sslmode=require&options=-c%20statement_timeout%3D5000';
  const options = databaseConnectionOptions(url, config);
  const original = new URL(url),
    parsed = new URL(options.connectionString!);
  expect(parsed.username).toBe(original.username);
  expect(parsed.password).toBe(original.password);
  expect(parsed.pathname).toBe(original.pathname);
  expect(parsed.searchParams.get('options')).toBe('-c statement_timeout=5000');
});

it('applies the same verified connection settings to runtime pools', async () => {
  const pool = makePool(connection + '?sslmode=require', config);
  try {
    const client = new pg.Client(pool.options);
    const tls = (client as unknown as { connectionParameters: { ssl: ConnectionOptions } })
      .connectionParameters.ssl;
    expect(tls.rejectUnauthorized).toBe(true);
    expect(tls.ca).toBeDefined();
  } finally {
    await pool.end();
  }
});

it.each(['NODE_TLS_REJECT_UNAUTHORIZED', 'DB_SSL_REJECT_UNAUTHORIZED'])(
  'rejects the unsafe %s deployment workaround with a useful error',
  (key) => {
    vi.stubEnv(key, key === 'NODE_TLS_REJECT_UNAUTHORIZED' ? '0' : 'false');
    expect(() => databaseConnectionOptions(connection, config)).toThrow('configure DB_CA_CERT');
  },
);

it('rejects a programmatic verification bypass as well', () => {
  expect(() =>
    databaseConnectionOptions(connection, {
      ...config,
      DB_SSL_REJECT_UNAUTHORIZED: 'false',
    }),
  ).toThrow('certificate verification must stay enabled');
});

it('requires TLS in production while retaining explicit non-TLS local development', () => {
  vi.stubEnv('NODE_ENV', 'production');
  expect(() => databaseConnectionOptions(connection, { DB_SSL: 'false' })).toThrow('mandatory');
  vi.stubEnv('NODE_ENV', 'test');
  expect(
    databaseConnectionOptions('postgresql://fixture:fixture@localhost/postgres?sslmode=require', {
      DB_SSL: 'false',
    }).ssl,
  ).toBe(false);
});

it('rejects invalid URLs without disclosing password-bearing input', () => {
  for (const input of [
    'not-a-url-secret-password',
    'https://fixture:secret-password@example.test',
  ]) {
    expect(() => databaseConnectionOptions(input, config)).toThrow(
      'Invalid database connection URL.',
    );
    try {
      databaseConnectionOptions(input, config);
    } catch (error) {
      expect(String(error)).not.toContain('secret-password');
    }
  }
});
