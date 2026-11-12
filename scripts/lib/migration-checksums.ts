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

export const permanentSchoolDeletionUpgrade = {
  version: '20261111120000_permanent_school_deletion.sql',
  digest: '580dde10a1b84c7dddca819b0ffaf94da856ef0ccf6d9a1574336c733f2068d0',
  repair: '20261111120001_permanent_school_deletion_upgrade.sql',
  repairDigest: '4794a12d6c07d22481f7870c8847c9af97cddf3be26fb29b50b9fc7cb61d7430',
};

// Exact SHA-256 digests of the five recovered drafts, including their
// original Windows checkouts. Each draft converges via the pinned repair.
const permanentSchoolDeletionDrafts = new Set([
  '5b4c1ba8028dff4b8998afbb1729ec576d8c00f08a4647a68d660c11cec6448c',
  'bcf186e8727bf68de93f4fdb53da8a45b2442bfe964bdecffe98f5ff175d86f3',
  'be86b13380fd4d60cf3f7ab5d008be4519826099cdf6b913c91552dea63778c9',
  'ede0c29b426d443d84dda7890017eb4c962cc158c4bec83bda00785f07b4204f',
  '4f9cd2b8e3840c6e23fb0eb2bdfb32096bb6a4a7e9dea572ac67350c64afcdef',
  'f8d31bcfaff11c05aab746a26414a9f9764008f1c3c449fcb54cc300ea7fd7c5',
  '274f205e41986a341e7c1a6ab82a7fc4146fa8abd1bb09603f4e460726172ade',
  '2d92074d5dde4db7036fe1f51e9e9397655024316d8f8b572074e127f45375e1',
  '7b724306275b2f443852ada44c7f4b275d3e6c52a0746416a00043ad2ebb67f2',
  'b605e83e9a501e160219df2a864e5d078c56d6046d5c68106faa49f8cfce954b',
  '7e2634f72348b7525119622fd381cbbda01174871656fcb55b43147ded795980',
]);

export function matchesPermanentSchoolDeletionDraft(
  version: string,
  canonicalDigest: string,
  recorded: string,
) {
  return (
    version === permanentSchoolDeletionUpgrade.version &&
    canonicalDigest === permanentSchoolDeletionUpgrade.digest &&
    permanentSchoolDeletionDrafts.has(recorded)
  );
}
