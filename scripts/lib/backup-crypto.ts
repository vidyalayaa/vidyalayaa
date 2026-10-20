import { createCipheriv, createDecipheriv, randomBytes, hkdfSync, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat, link, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
const magic = Buffer.from('VIDYABK1'),
  headerSize = 52,
  tagSize = 16;
function key(secret: string, salt: Buffer) {
  if (!/^[a-f0-9]{64}$/i.test(secret)) throw new Error('BACKUP_KEY_MUST_BE_32_BYTES_HEX');
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(secret, 'hex'), salt, Buffer.from('vidyalayaa-backup-v1'), 32),
  );
}
export async function encryptBackup(input: Readable, target: string, secret: string) {
  const salt = randomBytes(32),
    nonce = randomBytes(12),
    header = Buffer.concat([magic, salt, nonce]);
  const cipher = createCipheriv('aes-256-gcm', key(secret, salt), nonce);
  cipher.setAAD(header);
  const partial = target + '.partial',
    out = createWriteStream(partial, { flags: 'wx', mode: 0o600 });
  try {
    out.write(header);
    await pipeline(input, cipher, out);
    const handle = await open(partial, 'a');
    try {
      await handle.write(cipher.getAuthTag());
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(partial, target);
    await rm(partial);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return { bytes: (await stat(target)).size, sha256: await backupHash(target) };
}
export async function decryptBackup(source: string, target: string, secret: string) {
  const size = (await stat(source)).size;
  if (size < headerSize + tagSize) throw new Error('BACKUP_TRUNCATED');
  const handle = await open(source, 'r'),
    header = Buffer.alloc(headerSize),
    tag = Buffer.alloc(tagSize);
  try {
    await handle.read(header, 0, headerSize, 0);
    await handle.read(tag, 0, tagSize, size - tagSize);
  } finally {
    await handle.close();
  }
  if (!header.subarray(0, 8).equals(magic)) throw new Error('BACKUP_FORMAT_INVALID');
  const cipher = createDecipheriv(
    'aes-256-gcm',
    key(secret, header.subarray(8, 40)),
    header.subarray(40),
  );
  cipher.setAAD(header);
  cipher.setAuthTag(tag);
  const partial = target + '.partial';
  try {
    await pipeline(
      createReadStream(source, { start: headerSize, end: size - tagSize - 1 }),
      cipher,
      createWriteStream(partial, { flags: 'wx', mode: 0o600 }),
    );
    await link(partial, target);
    await rm(partial);
  } catch {
    await rm(partial, { force: true });
    throw new Error('BACKUP_AUTHENTICATION_FAILED');
  }
}
export async function backupHash(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
