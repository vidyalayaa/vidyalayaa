import { it, expect } from 'vitest';
import { parseCsv, csvRecords } from '../../apps/web/src/lib/csv.js';
import { studentImportColumns, studentImportRowSchema } from '@vidyalayaa/contracts';
import { csvCell } from '../../apps/api/src/modules/school/student-export.js';
it('parses quoted CSV, commas, CRLF and escaped quotes', () => {
  expect(parseCsv('a,b\r\n"x,y","quote ""inside"""')).toEqual([
    ['a', 'b'],
    ['x,y', 'quote "inside"'],
  ]);
});
it('reads spreadsheet BOMs and preserves student codes and phone strings', () => {
  expect(
    csvRecords('\uFEFFstudent_code,first_name,email\r\n001,true,\r\n', studentImportColumns),
  ).toEqual([{ student_code: '001', first_name: 'true' }]);
});
it('rejects duplicate/unknown columns and extra or missing cells rather than discarding data', () => {
  expect(() => csvRecords('student_code,student_code\n1,2', studentImportColumns)).toThrow(
    'unique',
  );
  expect(() => csvRecords('student_code,password\n1,secret', studentImportColumns)).toThrow(
    'Unknown columns',
  );
  expect(() => csvRecords('student_code,first_name\n1,Name,extra', studentImportColumns)).toThrow(
    'CSV row 2',
  );
  expect(() => csvRecords('student_code,first_name\n1', studentImportColumns)).toThrow('CSV row 2');
  expect(() => csvRecords('student_code\n' + Array(501).fill('1').join('\n'))).toThrow('1–500');
});
it('exposes only Gender and two parent groups in the CSV contract', () => {
  expect(studentImportColumns).toContain('gender');
  expect(studentImportColumns).toContain('parent_2_full_name');
  expect(studentImportColumns.some((column) => column.startsWith('parent_3_'))).toBe(false);
  const row = {
    student_code: 'TWO',
    first_name: 'Learner',
    class_grade: '8',
    class_section: 'A',
    starts_on: '2026-01-01',
    parent_3_full_name: 'Third',
  };
  expect(studentImportRowSchema.safeParse(row).success).toBe(false);
});
it('validates dates and gender and accepts explicit CSV booleans without coercing false to true', () => {
  const row = {
    student_code: '1',
    first_name: 'Name',
    class_grade: '8',
    class_section: 'A',
    starts_on: '2026-01-01',
    gender: 'female',
    parent_1_can_receive_alerts: 'FALSE',
  };
  expect(studentImportRowSchema.parse(row)).toMatchObject({
    gender: 'FEMALE',
    parent_1_can_receive_alerts: false,
  });
  expect(studentImportRowSchema.safeParse({ ...row, starts_on: '2026-02-30' }).success).toBe(false);
  expect(
    studentImportRowSchema.safeParse({ ...row, parent_1_can_receive_alerts: 'yes' }).success,
  ).toBe(false);
  expect(studentImportRowSchema.safeParse({ ...row, user_id: crypto.randomUUID() }).success).toBe(
    false,
  );
});
it('neutralizes spreadsheet formulas and quotes commas, newlines and embedded quotes', () => {
  for (const value of ['=1+1', '+911234567890', '-2+3', '@SUM(A1)', ' \t=1'])
    expect(csvCell(value)).toContain("'");
  expect(parseCsv(csvCell('Parent, "Name"\nSecond line'))).toEqual([
    ['Parent, "Name"\nSecond line'],
  ]);
  expect(csvCell(false)).toBe('"false"');
});
