import { it, expect } from 'vitest';
import { encrypt, decrypt, hash } from '../../apps/api/src/lib/crypto.js';
import { inQuietHours, messageFor, retryDelays } from '../../apps/worker/src/outbox.js';
it('encrypts tokens with authenticated encryption and detects tampering', () => {
  const key = 'ab'.repeat(32),
    cipher = encrypt('private-token', key);
  expect(cipher).not.toContain('private-token');
  expect(decrypt(cipher, key)).toBe('private-token');
  expect(() => decrypt(cipher, 'cd'.repeat(32))).toThrow();
  expect(hash('abc')).toHaveLength(64);
});
it('supports overnight quiet hours', () => {
  expect(inQuietHours('23:00', '22:00', '06:00')).toBe(true);
  expect(inQuietHours('05:59', '22:00', '06:00')).toBe(true);
  expect(inQuietHours('12:00', '22:00', '06:00')).toBe(false);
});
it('uses event time rather than upload time without child names on lock screens', () => {
  expect(
    messageFor('STUDENT_ARRIVED', { event_time: '2026-10-12T02:42:00Z' }, 'Asia/Kolkata'),
  ).toContain('8:12');
});
it('uses the specified bounded retry progression', () => {
  expect(retryDelays.slice(0, 5)).toEqual([30, 120, 600, 1800, 7200]);
});
