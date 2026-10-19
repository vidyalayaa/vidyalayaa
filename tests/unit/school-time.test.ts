import { it, expect } from 'vitest';
import { fromDateTimeLocal, toDateTimeLocal } from '../../apps/web/src/lib/date-time';
import {
  readDraft,
  saveDraft,
  clearDrafts,
  suspendDrafts,
  resumeDrafts,
} from '../../apps/web/src/lib/drafts';
it('converts school wall time independently of the browser zone', () => {
  expect(toDateTimeLocal('2026-10-18T05:00:00Z', 'Asia/Kolkata')).toBe('2026-10-18T10:30');
  expect(fromDateTimeLocal('2026-10-18T10:30', 'Asia/Kolkata')).toBe('2026-10-18T05:00:00.000Z');
  expect(fromDateTimeLocal('2026-01-15T08:00', 'America/New_York')).toBe(
    '2026-01-15T13:00:00.000Z',
  );
});
it('rejects DST gaps and repeated times instead of silently changing a deadline', () => {
  expect(() => fromDateTimeLocal('2026-03-08T02:30', 'America/New_York')).toThrow('does not exist');
  expect(() => fromDateTimeLocal('2026-11-01T01:30', 'America/New_York')).toThrow('occurs twice');
});
it('isolates in-memory school drafts and clears them at account boundaries', () => {
  clearDrafts();
  saveDraft('user.schoolA.student', { first_name: 'Draft' });
  expect(readDraft('user.schoolB.student')).toEqual({});
  const value = readDraft('user.schoolA.student');
  value.first_name = 'Mutated';
  expect(readDraft('user.schoolA.student').first_name).toBe('Draft');
  clearDrafts();
  expect(readDraft('user.schoolA.student')).toEqual({});
});
it('restores a session-expiry checkpoint only to the same identity and clears it on explicit logout', () => {
  clearDrafts();
  saveDraft('user.school.student', { first_name: 'Unfinished' });
  suspendDrafts('user');
  clearDrafts(true);
  // Parallel failing requests must not replace the checkpoint with an empty draft map.
  suspendDrafts('user');
  expect(readDraft('user.school.student')).toEqual({});
  resumeDrafts('user');
  expect(readDraft('user.school.student').first_name).toBe('Unfinished');
  suspendDrafts('user');
  clearDrafts(true);
  resumeDrafts('different-user');
  expect(readDraft('user.school.student')).toEqual({});
  saveDraft('user.school.student', { first_name: 'Private' });
  suspendDrafts('user');
  clearDrafts();
  resumeDrafts('user');
  expect(readDraft('user.school.student')).toEqual({});
});
