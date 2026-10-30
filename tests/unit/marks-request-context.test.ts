import { it, expect } from 'vitest';
import { marksRequestContext } from '../../apps/web/src/lib/marks-request-context';
const school = {
  school_id: 'school-a',
  school_name: 'A',
  timezone: 'Asia/Kolkata',
  role: 'school_admin' as const,
  permissions: ['marks.write'],
};
const me = () => ({ id: 'owner', school, memberships: [school] });
it('accepts a verified single-school default without inventing a different header selector', () => {
  expect(marksRequestContext(me(), 'owner', 'school-a', '')).toEqual({
    userId: 'owner',
    schoolId: '',
  });
});
it('preserves explicit school and owner binding', () => {
  expect(marksRequestContext(me(), 'owner', 'school-a', 'school-a')).toEqual({
    userId: 'owner',
    schoolId: 'school-a',
  });
  for (const args of [
    ['other', 'school-a', 'school-a'],
    ['owner', 'school-b', ''],
    ['owner', 'school-a', 'school-b'],
  ])
    expect(() => marksRequestContext(me(), args[0], args[1], args[2])).toThrow(
      /account or school changed/,
    );
});
it('requires an explicit selection for multiple memberships and rejects unverified or stale defaults', () => {
  const multiple = { ...me(), memberships: [school, { ...school, school_id: 'school-b' }] };
  expect(() => marksRequestContext(multiple, 'owner', 'school-a', '')).toThrow();
  expect(marksRequestContext(multiple, 'owner', 'school-a', 'school-a').schoolId).toBe('school-a');
  expect(() => marksRequestContext(undefined, 'owner', 'school-a', '')).toThrow();
  expect(() =>
    marksRequestContext({ ...me(), memberships: [] }, 'owner', 'school-a', ''),
  ).toThrow();
  expect(() =>
    marksRequestContext(
      { ...me(), memberships: [{ ...school, school_id: 'school-b' }] },
      'owner',
      'school-a',
      '',
    ),
  ).toThrow();
});
