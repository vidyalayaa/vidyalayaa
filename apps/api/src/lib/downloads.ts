import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.js';
export function signedDownload(key: string, path: string, user: string, school: string) {
  const expires = Math.floor(Date.now() / 1000) + 60;
  const signature = createHmac('sha256', Buffer.from(key, 'hex'))
    .update(`download:${path}:${user}:${school}:${expires}`)
    .digest('hex');
  return { url: `${path}?expires=${expires}&signature=${signature}`, expires_in: 60 };
}
export function verifyDownload(
  key: string,
  path: string,
  user: string,
  school: string,
  expires: unknown,
  signature: unknown,
) {
  const n = Number(expires),
    s = String(signature || '');
  if (
    !Number.isInteger(n) ||
    n < Math.floor(Date.now() / 1000) ||
    n > Math.floor(Date.now() / 1000) + 60 ||
    !/^[a-f0-9]{64}$/.test(s)
  )
    throw new ApiError(403, 'DOWNLOAD_EXPIRED', 'This download link has expired.');
  const expected = createHmac('sha256', Buffer.from(key, 'hex'))
    .update(`download:${path}:${user}:${school}:${n}`)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(s, 'hex')))
    throw new ApiError(
      403,
      'DOWNLOAD_DENIED',
      'This download belongs to another session or school.',
    );
}
