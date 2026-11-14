import 'dotenv/config';
import pg from 'pg';
import { databaseConnectionOptions } from '../apps/api/src/lib/db.js';
import { readFile, readdir } from 'node:fs/promises';
import {
  canonicalMigration,
  matchesMigrationDigest,
  matchesPermanentSchoolDeletionDraft,
  migrationDigest,
  permanentSchoolDeletionUpgrade,
} from './lib/migration-checksums.js';
const url = process.env.MIGRATION_DATABASE_URL;
if (!url)
  throw new Error('Set MIGRATION_DATABASE_URL to a direct/session migration-owner connection.');
const seed = process.argv.includes('--seed');
if (seed) {
  const connection = URL.parse(url);
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.ALLOW_DEVELOPMENT_SEED !== 'true' ||
    !connection ||
    !['localhost', '127.0.0.1', '[::1]'].includes(connection.hostname.toLowerCase()) ||
    connection.searchParams.has('host')
  )
    throw new Error(
      'Development seed requires ALLOW_DEVELOPMENT_SEED=true and a non-production PostgreSQL URL pointing directly to localhost, 127.0.0.1 or [::1].',
    );
}
const client = new pg.Client(
  databaseConnectionOptions(url, {
    DB_SSL: process.env.DB_SSL === 'false' ? 'false' : 'true',
    DB_CA_CERT: process.env.DB_CA_CERT,
  }),
);
await client.connect();
try {
  if (process.argv.includes('--verify')) {
    await client.query(await readFile('db/tests/verify.sql', 'utf8'));
    console.info('Schema verification passed.');
  } else if (seed) {
    await client.query(await readFile('db/seeds/development.sql', 'utf8'));
    console.info('Explicit development fixtures applied.');
  } else {
    await client.query('SELECT pg_advisory_lock(748392610)');
    await client.query(
      'CREATE SCHEMA IF NOT EXISTS app; CREATE TABLE IF NOT EXISTS app.schema_migrations(version text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const migrations = (await readdir('db/migrations')).filter((x) => x.endsWith('.sql')).sort();
    const { repair, repairDigest } = permanentSchoolDeletionUpgrade;
    for (const [index, file] of migrations.entries()) {
      const source = await readFile(`db/migrations/${file}`, 'utf8'),
        sql = canonicalMigration(source),
        sha = migrationDigest(sql);
      if (file === repair && sha !== repairDigest)
        throw new Error(`School deletion upgrade checksum changed: ${file}`);
      const old = await client.query('SELECT sha256 FROM app.schema_migrations WHERE version=$1', [
        file,
      ]);
      if (old.rowCount) {
        const recorded = old.rows[0].sha256;
        if (!matchesMigrationDigest(source, recorded)) {
          if (
            !matchesPermanentSchoolDeletionDraft(file, sha, recorded) ||
            migrations[index + 1] !== repair
          ) {
            throw new Error(
              `Applied migration checksum changed: ${file}\nRecorded SHA-256: ${recorded}\nCheckout SHA-256 (LF): ${sha}`,
            );
          }
          console.info(`Verified an earlier version of ${file}. Checking ${repair} next.`);
        }
        continue;
      }
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path = public, extensions, pg_catalog');
      try {
        await client.query(sql);
        await client.query('INSERT INTO app.schema_migrations(version,sha256) VALUES($1,$2)', [
          file,
          sha,
        ]);
        await client.query('COMMIT');
        console.info(`Applied ${file}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
    await client.query('SELECT pg_advisory_unlock(748392610)');
  }
} finally {
  await client.end();
}
