import { it, expect } from 'vitest';
import { signedDownload, verifyDownload } from '../../apps/api/src/lib/downloads.js';
const key = 'ab'.repeat(32),
  path = '/reports/report-id/file';
it('binds private report links to identity, school, path and expiry', () => {
  const ticket = signedDownload(key, path, 'alice', 'school-a'),
    u = new URL(ticket.url, 'https://api.example.invalid');
  expect(() =>
    verifyDownload(
      key,
      path,
      'alice',
      'school-a',
      u.searchParams.get('expires'),
      u.searchParams.get('signature'),
    ),
  ).not.toThrow();
  expect(() =>
    verifyDownload(
      key,
      path,
      'bob',
      'school-a',
      u.searchParams.get('expires'),
      u.searchParams.get('signature'),
    ),
  ).toThrow();
  expect(() =>
    verifyDownload(
      key,
      path,
      'alice',
      'school-b',
      u.searchParams.get('expires'),
      u.searchParams.get('signature'),
    ),
  ).toThrow();
  expect(() =>
    verifyDownload(key, path, 'alice', 'school-a', '1', u.searchParams.get('signature')),
  ).toThrow();
});
