import { it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { encryptBackup, decryptBackup } from '../../scripts/lib/backup-crypto.js';
it('authenticates encrypted backups and never publishes a tampered or wrong-key restore', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vidyalayaa-backup-test-'));
  try {
    const source = Buffer.from('Private fixture: child and attendance data'),
      encrypted = join(dir, 'backup.bin');
    const manifest = await encryptBackup(Readable.from([source]), encrypted, '12'.repeat(32));
    expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await readFile(encrypted)).includes(source)).toBe(false);
    await expect(
      encryptBackup(Readable.from([Buffer.from('replacement')]), encrypted, '12'.repeat(32)),
    ).rejects.toThrow();
    const restored = join(dir, 'restored');
    await decryptBackup(encrypted, restored, '12'.repeat(32));
    expect(await readFile(restored)).toEqual(source);
    await expect(decryptBackup(encrypted, join(dir, 'wrong'), '34'.repeat(32))).rejects.toThrow(
      'BACKUP_AUTHENTICATION_FAILED',
    );
    await expect(readFile(join(dir, 'wrong'))).rejects.toThrow();
    const tampered = await readFile(encrypted);
    tampered[55] ^= 1;
    await writeFile(join(dir, 'tampered'), tampered);
    await expect(
      decryptBackup(join(dir, 'tampered'), join(dir, 'invalid'), '12'.repeat(32)),
    ).rejects.toThrow('BACKUP_AUTHENTICATION_FAILED');
    await expect(readFile(join(dir, 'invalid.partial'))).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
