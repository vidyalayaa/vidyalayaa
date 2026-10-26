import 'dotenv/config';
import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import {
  canonicalMigration,
  matchesMigrationDigest,
  migrationDigest,
} from './lib/migration-checksums.js';
const url = process.env.MIGRATION_DATABASE_URL;
if (!url)
  throw new Error('Set MIGRATION_DATABASE_URL to a direct/session migration-owner connection.');
const client = new pg.Client({
  connectionString: url,
  ssl:
    process.env.DB_SSL === 'false'
      ? false
      : {
          rejectUnauthorized: true,
          ...(process.env.DB_CA_CERT ? { ca: process.env.DB_CA_CERT.replace(/\\n/g, '\n') } : {}),
        },
});
await client.connect();
try {
  if (process.argv.includes('--verify')) {
    await client.query(await readFile('db/tests/verify.sql', 'utf8'));
    console.info('Schema verification passed.');
  } else if (process.argv.includes('--seed')) {
    if (process.env.NODE_ENV === 'production' || process.env.ALLOW_DEVELOPMENT_SEED !== 'true')
      throw new Error(
        'Development seed requires ALLOW_DEVELOPMENT_SEED=true and a non-production environment.',
      );
    await client.query(await readFile('db/seeds/development.sql', 'utf8'));
    console.info('Explicit development fixtures applied.');
  } else {
    await client.query('SELECT pg_advisory_lock(748392610)');
    await client.query(
      'CREATE SCHEMA IF NOT EXISTS app; CREATE TABLE IF NOT EXISTS app.schema_migrations(version text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const file of (await readdir('db/migrations')).filter((x) => x.endsWith('.sql')).sort()) {
      const source = await readFile(`db/migrations/${file}`, 'utf8'),
        sql = canonicalMigration(source),
        sha = migrationDigest(sql),
        old = await client.query('SELECT sha256 FROM app.schema_migrations WHERE version=$1', [
          file,
        ]);
      if (old.rowCount) {
        if (!matchesMigrationDigest(source, old.rows[0].sha256))
          throw new Error(`Applied migration checksum changed: ${file}`);
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
