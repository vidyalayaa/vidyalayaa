import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export function equalHash(a: string, b: Buffer) {
  const h = Buffer.from(hash(a), 'hex');
  return b.length === h.length && timingSafeEqual(h, b);
}
export function encrypt(value: string, key: string) {
  const iv = randomBytes(12),
    c = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  return Buffer.concat([iv, c.update(value, 'utf8'), c.final(), c.getAuthTag()]).toString('base64');
}
export function decrypt(value: string, key: string) {
  const b = Buffer.from(value, 'base64'),
    d = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), b.subarray(0, 12));
  d.setAuthTag(b.subarray(-16));
  return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString('utf8');
}
