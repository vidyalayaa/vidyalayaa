import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve,dirname,basename } from 'node:path';
import { Readable } from 'node:stream';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { transaction } from '../../apps/api/src/lib/db.js';
import { encryptBackup, decryptBackup } from '../../scripts/lib/backup-crypto.js';
it('restores an authenticated isolated database snapshot with identities, records and forced isolation intact', async () => {
  const original = await portableDatabase(),
    f = await fixture(original),
    dir = await mkdtemp(join(tmpdir(), 'vidyalayaa-restore-test-'));
  let restored: PGlite | undefined;
  try {
    const dump = await original.dumpDataDir();
    await encryptBackup(
      Readable.from([Buffer.from(await dump.arrayBuffer())]),
      join(dir, 'backup'),
      '56'.repeat(32),
    );
    await decryptBackup(join(dir, 'backup'), join(dir, 'plain'), '56'.repeat(32));
    restored = new PGlite({
      loadDataDir: new Blob([await readFile(join(dir, 'plain'))]),
      extensions: { btree_gist, pgcrypto, citext },
    });
    const pools = poolAdapters(restored);
    const own = await transaction(
      pools.api,
      { schoolId: f.schoolA, userId: f.admin },
      (tx) => tx.query('SELECT id FROM students'),
      true,
    );
    expect(own.rows.map((x) => x.id)).toEqual([f.student]);
    const other = await transaction(
      pools.api,
      { schoolId: f.schoolB, userId: f.admin },
      (tx) => tx.query('SELECT id FROM students'),
      true,
    );
    expect(other.rows.map((x) => x.id)).toEqual([f.foreignStudent]);
    expect(
      (await restored.query('SELECT id FROM auth.users WHERE id=$1', [f.parent])).rows,
    ).toHaveLength(1);
    await restored.exec(await readFile('db/tests/verify.sql', 'utf8'));
  } finally {
    await restored?.close();
    await original.close();
    if(dirname(resolve(dir))!==resolve(tmpdir())||!basename(dir).startsWith('vidyalayaa-restore-test-'))throw new Error('RESTORE_TEMP_PATH_INVALID');
    await rm(dir, { recursive: true, force: true });
  }
});
