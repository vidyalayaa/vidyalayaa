import { it, expect } from 'vitest';
import type { MarksEntrySheet } from '@vidyalayaa/contracts';
import { marksTemplate, parseMarksSheet } from '../../apps/web/src/lib/marks-entry';
import { parseCsv } from '../../apps/web/src/lib/csv';
const exam = crypto.randomUUID(),
  subject = crypto.randomUUID(),
  student = crypto.randomUUID();
const sheet = (): MarksEntrySheet => ({
  exam: {
    id: exam,
    name: 'Unit test',
    class_id: crypto.randomUUID(),
    assessment_kind: 'SUBJECT_TEST',
    subject_id: subject,
    max_score: 50,
  },
  classroom: { grade: '2', section: 'A', academic_session: '2026' },
  subjects: [{ id: subject, code: 'MATH', name: 'Mathematics' }],
  students: [
    {
      id: student,
      student_code: '001',
      first_name: 'Sample',
      last_name: 'Learner',
      roll_number: '02',
    },
  ],
  marks: [],
});
it('prefills all class/student/subject identifiers, preserves leading zeros, and leaves unrecorded scores blank', () => {
  const s = sheet(),
    [headers, row] = parseCsv(marksTemplate(s, subject));
  expect(Object.fromEntries(headers.map((h, i) => [h, row[i]]))).toMatchObject({
    exam_id: exam,
    student_code: '001',
    roll_number: '02',
    student_name: 'Sample Learner',
    subject_code: 'MATH',
    subject_name: 'Mathematics',
    score: '',
  });
  expect(() => parseMarksSheet(marksTemplate(s, subject), s)).toThrow(/at least one score/);
});
it('roundtrips existing zero scores, quoted names and remarks without changing identities', () => {
  const s = sheet();
  s.students[0].first_name = 'Test, "Student"';
  s.marks = [
    { student_id: student, subject_id: subject, score: 0, remarks: 'Good, steady\nprogress' },
  ];
  expect(parseMarksSheet(marksTemplate(s, subject), s).body.entries).toEqual(s.marks);
});
it('keeps legacy CSV compatible, skips blank scores and maps errors to original file rows', () => {
  const s = sheet();
  const parsed = parseMarksSheet(
    'student_code,subject_code,score,remarks\n001,MATH,,\n001,MATH,25,ok',
    s,
  );
  expect(parsed.body.entries[0].score).toBe(25);
  expect(parsed.sourceRows).toEqual([3]);
});
it('rejects foreign students/subjects, wrong examinations, mismatched rolls, invalid scores and duplicate pairs', () => {
  const s = sheet();
  for (const csv of [
    'student_code,subject_code,score\nOTHER,MATH,20',
    'student_code,subject_code,score\n001,OTHER,20',
    'student_code,subject_code,score\n001,MATH,51',
    'student_code,subject_code,score\n001,MATH,-1',
    'student_code,subject_code,score\n001,MATH,NaN',
    'student_code,subject_code,score\n001,MATH,25\n001,MATH,26',
    `exam_id,student_code,subject_code,score\n${crypto.randomUUID()},001,MATH,20`,
    'roll_number,student_code,subject_code,score\n99,001,MATH,20',
  ])
    expect(() => parseMarksSheet(csv, s)).toThrow();
});
it('protects spreadsheet formulas in labels and creates complete non-overlapping 500-row batches', () => {
  const s = sheet();
  s.students = Array.from({ length: 501 }, (_, i) => ({
    id: crypto.randomUUID(),
    student_code: 'S' + i,
    first_name: i === 0 ? '=FORMULA()' : 'Learner',
    last_name: null,
    roll_number: String(i + 1),
  }));
  const first = parseCsv(marksTemplate(s, subject, 0)),
    second = parseCsv(marksTemplate(s, subject, 1));
  expect(first).toHaveLength(501);
  expect(second).toHaveLength(2);
  expect(first[1][6]).toBe("'=FORMULA()");
  expect(second[1][5]).toBe('S500');
});
it('imports spreadsheet-stripped leading zeros for authorized subject/student codes and rolls', () => {
  const s = sheet();
  s.subjects[0].code = '0205';
  const result = parseMarksSheet(
    'student_code,subject_code,roll_number,score,remarks\n1,205,2,48,good',
    s,
  );
  expect(result.body.entries).toEqual([
    { student_id: student, subject_id: subject, score: 48, remarks: 'good' },
  ]);
});
it('rejects ambiguous numeric identifiers without selecting an exact-looking but potentially wrong record', () => {
  const s = sheet();
  s.subjects[0].code = '0205';
  s.subjects.push({ id: crypto.randomUUID(), code: '205', name: 'Another subject' });
  expect(() => parseMarksSheet('student_code,subject_code,score\n001,205,20', s)).toThrow(
    /subject code "205" matches more than one/,
  );
  expect(
    parseMarksSheet('student_code,subject_code,score\n001,0205,20', s).body.entries[0].subject_id,
  ).toBe(subject);
  s.subjects.pop();
  s.students.push({ ...s.students[0], id: crypto.randomUUID(), student_code: '1' });
  expect(() => parseMarksSheet('student_code,subject_code,score\n1,205,20', s)).toThrow(
    /student code "1" matches more than one/,
  );
});
it('does not guess decimal/exponent identifiers or normalize alphanumeric codes', () => {
  const s = sheet();
  s.subjects[0].code = '0205';
  for (const code of ['2.05e2', '205.0', '+205', 'COMPUTER205'])
    expect(() => parseMarksSheet(`student_code,subject_code,score\n001,${code},20`, s)).toThrow(
      /subject code/,
    );
});
