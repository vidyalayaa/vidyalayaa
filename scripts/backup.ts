import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm, stat, readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import pg from 'pg';
import { encryptBackup, decryptBackup, backupHash } from './lib/backup-crypto.js';
// Deliberately does not load .env: a backup/restore requires its own explicit target.
const mode = process.argv[2],
  file = process.argv[3],
  secret = process.env.BACKUP_ENCRYPTION_KEY;
if (!file || !secret || !['create', 'restore-test'].includes(mode))
  throw new Error(
    'Use: tsx scripts/backup.ts create|restore-test FILE; configure BACKUP_ENCRYPTION_KEY and the explicit target URL.',
  );
const url = new URL(
  process.env[mode === 'create' ? 'BACKUP_DATABASE_URL' : 'RESTORE_TEST_DATABASE_URL'] || '',
);
if (!['postgresql:', 'postgres:'].includes(url.protocol)) throw new Error('POSTGRES_URL_REQUIRED');
const env = {
  ...process.env,
  PGHOST: url.hostname,
  PGPORT: url.port || '5432',
  PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGSSLMODE: process.env.BACKUP_DB_SSL === 'false' ? 'disable' : 'verify-full',
  ...(process.env.BACKUP_CA_PATH ? { PGSSLROOTCERT: process.env.BACKUP_CA_PATH } : {}),
};
const target = resolve(file);
await mkdir(dirname(target), { recursive: true });
function tool(name: string, args: string[]) {
  const child = spawn(name, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  // Never echo the process environment, server error text, connection strings or records.
  child.stderr.resume();
  const done = new Promise<void>((ok, fail) => {
    child.once('error', () => fail(new Error('POSTGRES_TOOL_UNAVAILABLE')));
    child.once('exit', (code) => (code === 0 ? ok() : fail(new Error('POSTGRES_TOOL_FAILED'))));
  });
  return { child, done };
}
if (mode === 'create') {
  try {
    await stat(target);
    throw new Error('BACKUP_TARGET_ALREADY_EXISTS');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const started = new Date().toISOString(),
    dump = tool(process.env.PG_DUMP_PATH || 'pg_dump', [
      '--format=custom',
      '--compress=0',
      '--no-owner',
    ]);
  // Observe process rejection immediately while the encrypted stream is still writing.
  const finished = dump.done.catch((error) => {
    dump.child.stdout.destroy(error);
    throw error;
  });
  try {
    const [encrypted, processResult] = await Promise.allSettled([
      encryptBackup(dump.child.stdout, target, secret),
      finished,
    ]);
    if (encrypted.status === 'rejected') throw encrypted.reason;
    if (processResult.status === 'rejected') {
      await rm(target, { force: true });
      throw processResult.reason;
    }
    const manifest = encrypted.value;
    await writeFile(
      target + '.manifest.json',
      JSON.stringify(
        {
          version: 1,
          created_at: started,
          encrypted: true,
          format: 'pg_dump-custom',
          ...manifest,
          objects_included: false,
          restore_verified: false,
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    console.info(
      'Encrypted database backup created; object storage and restore verification are separate required steps.',
    );
  } catch (error) {
    dump.child.kill();
    throw error;
  }
} else {
  if (!env.PGDATABASE.endsWith('_restore_test') || process.env.CONFIRM_ISOLATED_RESTORE !== 'true')
    throw new Error('RESTORE_REQUIRES_EXPLICIT_DISPOSABLE_restore_test_DATABASE');
  const db = new pg.Client({
    connectionString: url.toString(),
    ssl:
      env.PGSSLMODE === 'disable'
        ? false
        : {
            rejectUnauthorized: true,
            ...(process.env.BACKUP_CA_PATH
              ? { ca: await readFile(process.env.BACKUP_CA_PATH, 'utf8') }
              : {}),
          },
  });
  await db.connect();
  try {
    const tables = await db.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') LIMIT 1",
    );
    if (tables.rowCount) throw new Error('RESTORE_TARGET_NOT_EMPTY');
  } finally {
    await db.end();
  }
  const plaintext = join(dirname(target), '.restore-' + crypto.randomUUID() + '.dump');
  try {
    await decryptBackup(target, plaintext, secret); // Authentication completes before pg_restore can see any bytes.
    const restore = tool(process.env.PG_RESTORE_PATH || 'pg_restore', [
      '--exit-on-error',
      '--no-owner',
      '--dbname',
      env.PGDATABASE,
      plaintext,
    ]);
    await restore.done;
    await writeFile(
      target + '.restore-test.json',
      JSON.stringify(
        {
          verified_at: new Date().toISOString(),
          backup_sha256: await backupHash(target),
          database_restored: true,
          application_and_storage_checks: 'REQUIRED',
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
    console.info(
      'Isolated database restore completed. Run schema, role, row-count, ownership and object-integrity checks before recording recovery acceptance.',
    );
  } finally {
    await rm(plaintext, { force: true });
  }
}
