import { it, expect } from 'vitest';
import {
  canonicalMigration,
  matchesMigrationDigest,
  migrationDigest,
} from '../../scripts/lib/migration-checksums.js';
it('accepts historical LF and CRLF checkouts without changing stored checksums', () => {
  const lf = 'CREATE TABLE sample(id uuid);\n-- preserve history\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  for (const contents of [lf, crlf])
    for (const recorded of [migrationDigest(lf), migrationDigest(crlf)])
      expect(matchesMigrationDigest(contents, recorded)).toBe(true);
});
it('rejects actual SQL, comment, and whitespace edits to applied migrations', () => {
  const sql = 'SELECT 1;\n';
  for (const changed of ['SELECT 2;\n', 'SELECT 1; -- changed\n', 'SELECT  1;\n'])
    expect(matchesMigrationDigest(changed, migrationDigest(sql))).toBe(false);
});
it('executes and hashes the same canonical bytes for new migrations', () => {
  const lf = 'SELECT 1;\nSELECT 2;\n';
  const normalized = canonicalMigration(lf.replace(/\n/g, '\r\n'));
  expect(normalized).toBe(lf);
  expect(migrationDigest(canonicalMigration(lf))).toBe(migrationDigest(lf));
});
