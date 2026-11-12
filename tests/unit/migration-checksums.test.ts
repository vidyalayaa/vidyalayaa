import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  canonicalMigration,
  matchesMigrationDigest,
  matchesPermanentSchoolDeletionDraft,
  migrationDigest,
  permanentSchoolDeletionUpgrade,
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

it('only recognizes an exact deletion draft for the original release and its pinned repair', async () => {
  const { version, digest, repair, repairDigest } = permanentSchoolDeletionUpgrade;
  const [source, upgrade] = await Promise.all(
    [version, repair].map((file) => readFile(`db/migrations/${file}`, 'utf8')),
  );
  expect(migrationDigest(canonicalMigration(source))).toBe(digest);
  expect(migrationDigest(canonicalMigration(upgrade))).toBe(repairDigest);
  const draft = 'b605e83e9a501e160219df2a864e5d078c56d6046d5c68106faa49f8cfce954b';
  expect(matchesMigrationDigest(source, draft)).toBe(false);
  expect(matchesPermanentSchoolDeletionDraft(version, digest, draft)).toBe(true);
  expect(matchesPermanentSchoolDeletionDraft(repair, digest, draft)).toBe(false);
  expect(matchesPermanentSchoolDeletionDraft(version, migrationDigest(source + ' '), draft)).toBe(
    false,
  );
  expect(matchesPermanentSchoolDeletionDraft(version, digest, '0'.repeat(64))).toBe(false);
});
