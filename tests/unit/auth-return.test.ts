import { expect, it } from 'vitest';
import { safeReturnTo } from '../../apps/web/src/lib/auth-return';

it('keeps authentication return paths within the application', () => {
  for (const path of [
    '/platform/schools',
    '/teacher/r/assignments?page=2',
    '/parent/attendance#today',
  ])
    expect(safeReturnTo(path)).toBe(path);
  for (const path of [
    null,
    '',
    'https://elsewhere.test',
    '//elsewhere.test',
    '/\\elsewhere.test',
    '/\n/elsewhere.test',
    '/login',
    '/auth/google/callback?code=secret',
    '/admin/../login',
  ])
    expect(safeReturnTo(path)).toBe('/');
});
