import { createHash } from 'node:crypto';

export const canonicalMigration = (sql: string) => sql.replace(/\r\n/g, '\n');
export const migrationDigest = (sql: string) => createHash('sha256').update(sql).digest('hex');

// Older releases recorded the exact checkout bytes. Recognize only LF/CRLF
// variants, never whitespace/content edits, and never rewrite recorded history.
export function matchesMigrationDigest(source: string, recorded: string) {
  const lf = canonicalMigration(source);
  return [source, lf, lf.replace(/\n/g, '\r\n')].some(
    (value) => migrationDigest(value) === recorded,
  );
}
