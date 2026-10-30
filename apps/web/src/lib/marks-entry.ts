import { bulkMarksSchema, type MarksEntrySheet } from '@vidyalayaa/contracts';
import { parseCsv } from './csv';

export const marksSheetColumns = [
  'exam_id',
  'exam_name',
  'class_grade',
  'class_section',
  'roll_number',
  'student_code',
  'student_name',
  'subject_code',
  'subject_name',
  'score',
  'remarks',
];
const safeCell = (v: unknown) => {
  const s = String(v ?? '');
  return /^[=+@\-\t\r]/.test(s) ? "'" + s : s;
};
const matches = (value: string, original: unknown) =>
  value === String(original ?? '') || value === safeCell(original);
// Spreadsheet apps can turn a text identifier such as 0205 into 205. Resolve
// only against this authorized sheet; never guess between two matching records.
const numericCode = (value: string) =>
  /^\d+$/.test(value) ? value.replace(/^0+(?=\d)/, '') : undefined;
function resolveCode<T>(
  value: string,
  records: T[],
  code: (record: T) => string,
  row: number,
  kind: string,
) {
  const exact = records.filter((record) => matches(value, code(record)));
  const numeric = numericCode(value);
  if (numeric === undefined || (exact.length === 1 && /^0\d/.test(value))) return exact[0];
  const candidates = records.filter((record) => numericCode(code(record)) === numeric);
  if (candidates.length > 1)
    throw new Error(
      `CSV row ${row}: ${kind} code "${value}" matches more than one record after leading zeros were removed. Preserve the original codes as Text and download a fresh template.`,
    );
  return candidates[0];
}
export function marksTemplate(sheet: MarksEntrySheet, subjectId: string, batch = 0) {
  const subject = sheet.subjects.find((s) => s.id === subjectId);
  if (!subject) throw new Error('Choose an available subject.');
  const records = sheet.students.slice(batch * 500, (batch + 1) * 500).map((student) => {
    const existing = sheet.marks.find(
      (m) => m.student_id === student.id && m.subject_id === subject.id,
    );
    return [
      sheet.exam.id,
      sheet.exam.name,
      sheet.classroom.grade,
      sheet.classroom.section,
      student.roll_number,
      student.student_code,
      [student.first_name, student.last_name].filter(Boolean).join(' '),
      subject.code,
      subject.name,
      existing?.score ?? '',
      existing?.remarks ?? '',
    ];
  });
  const escape = (v: unknown) => '"' + safeCell(v).replaceAll('"', '""') + '"';
  return (
    '\uFEFF' +
    [marksSheetColumns, ...records].map((r) => r.map(escape).join(',')).join('\r\n') +
    '\r\n'
  );
}
export function parseMarksSheet(csv: string, sheet: MarksEntrySheet) {
  const rows = parseCsv(csv),
    header = rows.shift()?.map((x) => x.trim().toLowerCase());
  if (
    !header ||
    new Set(header).size !== header.length ||
    ['student_code', 'subject_code', 'score'].some((k) => !header.includes(k)) ||
    header.some((k) => !marksSheetColumns.includes(k))
  )
    throw new Error(
      'Use the downloaded marks template, or columns: student_code,subject_code,score,remarks.',
    );
  if (!rows.length || rows.length > 500)
    throw new Error(
      'Include between 1 and 500 CSV rows. Download a separate batch for a larger class.',
    );
  const sourceRows: number[] = [];
  const entries = rows.flatMap((r, i) => {
    if (r.length !== header.length)
      throw new Error(`CSV row ${i + 2}: the number of cells does not match the header.`);
    const value = (k: string) => r[header.indexOf(k)]?.trim() || '';
    if (!value('score')) return [];
    if (value('exam_id') && value('exam_id') !== sheet.exam.id)
      throw new Error(`CSV row ${i + 2}: this file belongs to a different examination.`);
    const student = resolveCode(
        value('student_code'),
        sheet.students,
        (s) => s.student_code,
        i + 2,
        'student',
      ),
      subject = resolveCode(value('subject_code'), sheet.subjects, (s) => s.code, i + 2, 'subject');
    if (!student)
      throw new Error(
        `CSV row ${i + 2}: student code "${value('student_code')}" is not enrolled in this examination's class. Download a fresh template and preserve codes as Text.`,
      );
    if (!subject)
      throw new Error(
        `CSV row ${i + 2}: subject code "${value('subject_code')}" is not configured for this examination's class. Download a fresh template and preserve codes as Text.`,
      );
    if (
      value('roll_number') &&
      !matches(value('roll_number'), student.roll_number) &&
      !(
        numericCode(value('roll_number')) !== undefined &&
        numericCode(value('roll_number')) === numericCode(student.roll_number || '')
      )
    )
      throw new Error(
        `CSV row ${i + 2}: roll number does not match the student. Download a fresh template.`,
      );
    const score = Number(value('score'));
    if (!Number.isFinite(score) || score < 0 || score > sheet.exam.max_score)
      throw new Error(`CSV row ${i + 2}: enter a score from 0 to ${sheet.exam.max_score}.`);
    sourceRows.push(i + 2);
    const previous = sheet.marks.find(
      (m) => m.student_id === student.id && m.subject_id === subject.id,
    );
    return [
      {
        student_id: student.id,
        subject_id: subject.id,
        score,
        remarks: header.includes('remarks')
          ? r[header.indexOf('remarks')] || null
          : (previous?.remarks ?? null),
      },
    ];
  });
  if (!entries.length)
    throw new Error(
      'Enter at least one score. Blank score cells are skipped and never saved as zero.',
    );
  return { body: bulkMarksSchema.parse({ exam_id: sheet.exam.id, entries }), sourceRows };
}
