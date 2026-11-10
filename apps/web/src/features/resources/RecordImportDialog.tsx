import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, useAuth, HttpError } from '../../lib/auth';
import { csvRecords, saveCsv } from '../../lib/csv';
import {
  studentImportColumns,
  studentImportFields,
  guardianImportFields,
  staffDetailFields,
} from '@vidyalayaa/contracts';
import { readDraft, saveDraft, deleteDraft } from '../../lib/drafts';
import { useUnsavedChanges } from '../../lib/use-unsaved-changes';
import { Dialog } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';

const columns = {
  students: studentImportColumns.join(','),
  parents: 'full_name,email,phone,account_email,status',
  teachers: [
    'staff_code',
    'full_name',
    'email',
    'staff_role',
    'account_email',
    'status',
    ...staffDetailFields,
  ].join(','),
  student_parents:
    'student_code,parent_email,relationship,is_primary_contact,can_receive_alerts,status',
  teacher_class_assignments:
    'teacher_code,class_grade,class_section,subject_code,starts_on,ends_on',
};
export type ImportResource = keyof typeof columns;
export default function RecordImportDialog({
  resource,
  close,
}: {
  resource: ImportResource;
  close: () => void;
}) {
  const a = useAuth(),
    qc = useQueryClient(),
    key = `${a.me?.id}:${a.school}:import:${resource}${resource === 'students' ? ':admissions-v1' : ''}`,
    [text, setText] = useState(() => String(readDraft(key).text || '')),
    [validated, setValidated] = useState(false),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false),
    [progress, setProgress] = useState<{
      stage: 'validating' | 'validated' | 'importing' | 'complete' | 'error';
      rows: number;
    } | null>(null),
    [result, setResult] = useState(''),
    inFlight = useRef(false),
    idempotency = useRef(crypto.randomUUID());
  useUnsavedChanges(!!text && !result);
  const excelKind =
    resource === 'students' ? 'student' : resource === 'teachers' ? 'staff' : undefined;
  function change(value: string) {
    setText(value);
    setError('');
    saveDraft(key, { text: value });
    setValidated(false);
    setProgress(null);
    setResult('');
    idempotency.current = crypto.randomUUID();
  }
  async function submit(commit: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError('');
    setProgress({ stage: commit ? 'importing' : 'validating', rows: progress?.rows || 0 });
    try {
      const rows = csvRecords(
        text,
        resource === 'students' ? [...studentImportColumns, 'admission_number'] : undefined,
      );
      if (excelKind) {
        const primary = excelKind === 'student' ? 'student_code' : 'staff_code';
        const alias = excelKind === 'student' ? 'admission_number' : 'employee_id';
        for (const row of rows) {
          if (!row[alias]) continue;
          if (row[primary] && row[primary] !== row[alias])
            throw new Error(`Use one value for ${primary} or ${alias}.`);
          row[primary] = row[alias];
          delete row[alias];
        }
      }
      setProgress({ stage: commit ? 'importing' : 'validating', rows: rows.length });
      const values =
        resource === 'students'
          ? rows
          : rows.map((row) =>
              Object.fromEntries(
                Object.entries(row).map(([key, value]) => [
                  key,
                  ['true', 'false'].includes(value.toLowerCase()) &&
                  ['is_primary_contact', 'can_receive_alerts'].includes(key)
                    ? value.toLowerCase() === 'true'
                    : value,
                ]),
              ),
            );
      const endpoint =
        resource === 'students' ? '/student-directory/imports' : `/imports/${resource}`;
      const r = await api<{ validated: number; imported: number }>(endpoint, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotency.current },
        body: JSON.stringify({ rows: values, validate_only: !commit }),
      });
      if (commit) {
        setProgress({ stage: 'complete', rows: r.imported });
        setValidated(false);
        setResult(
          resource === 'students'
            ? `${r.imported} student${r.imported === 1 ? '' : 's'} imported with class enrollments and family connections.`
            : `${r.imported} records imported.`,
        );
        deleteDraft(key);
        setText('');
        qc.invalidateQueries({ queryKey: [a.school] });
      } else {
        setProgress({ stage: 'validated', rows: r.validated });
        setValidated(true);
        setResult('');
      }
    } catch (e) {
      setProgress((current) => ({ stage: 'error', rows: current?.rows || 0 }));
      const details = e instanceof HttpError && Array.isArray(e.details) ? e.details : [];
      setError(
        (e as Error).message +
          (details.length
            ? ' ' +
              details
                .map(
                  (x: { row: number; path?: (string | number)[]; message: string }) =>
                    `CSV row ${x.row + 1}${x.path?.length ? ` (${x.path.join('.')})` : ''}: ${x.message}`,
                )
                .join('; ')
            : '') +
          (details.length && excelKind
            ? ` 0 records saved. ${new Set(details.map((row: { row: number }) => row.row)).size} rows need correction.`
            : ''),
      );
      if (!commit || (e instanceof HttpError && e.status < 500 && ![408, 429].includes(e.status)))
        setValidated(false);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  async function loadFile(file: File) {
    if (inFlight.current) return;
    const xlsx = Boolean(excelKind && /\.xlsx$/i.test(file.name));
    inFlight.current = true;
    setPending(true);
    setError('');
    try {
      if (xlsx) {
        if (file.size > 2 * 1024 * 1024)
          throw new Error('Choose an Excel workbook no larger than 2 MB.');
        if (!a.me?.id || !a.school) throw new Error('Select a school before importing records.');
        const body = new FormData();
        body.append('workbook', file);
        const data = await api<{ csv: string }>(
          `/profiles/${excelKind}/workbook`,
          { method: 'POST', body },
          true,
          'json',
          { userId: a.me.id, schoolId: a.requestSchool },
        );
        change(data.csv);
      } else {
        if (file.size > 512000) throw new Error('Choose a CSV smaller than 500 KB.');
        change(await file.text());
      }
    } catch (e) {
      setError((e as Error).message);
      setValidated(false);
      setProgress(null);
      setResult('');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  const requestClose = () => {
    if (inFlight.current) return;
    if (!text || window.confirm('Close this import? Its draft stays only in this tab.')) close();
  };
  const progressLabel = !progress
    ? ''
    : progress.stage === 'validating'
      ? `Validating ${progress.rows || 'your'} records…`
      : progress.stage === 'importing'
        ? `Importing ${progress.rows} record${progress.rows === 1 ? '' : 's'}…`
        : progress.stage === 'validated'
          ? `${progress.rows} record${progress.rows === 1 ? '' : 's'} validated. Ready to import.`
          : progress.stage === 'complete'
            ? `Import complete. ${progress.rows} record${progress.rows === 1 ? '' : 's'} saved.`
            : validated
              ? 'Import not confirmed. Review the error below before retrying.'
              : 'Validation needs attention. Review the error below.';
  const completedSteps = progress?.stage === 'complete' ? 2 : validated ? 1 : 0;
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) requestClose();
      }}
      title={resource === 'students' ? 'Import students & families' : 'Import school records'}
      description={
        resource === 'students'
          ? 'One row per student: student details, class enrollment, parents and family connections. Validate the whole file before saving. Invite accounts afterward from Members & invitations.'
          : 'Validate the whole file before saving. Account emails must already have accepted the matching school invitation.'
      }
    >
      <div className="space-y-4">
        <Button
          variant="outline"
          disabled={pending}
          onClick={() =>
            saveCsv(
              new Blob(['\uFEFF' + columns[resource] + '\r\n'], { type: 'text/csv;charset=utf-8' }),
              `vidyalayaa-${resource}-import-template.csv`,
            )
          }
        >
          Download CSV template
        </Button>
        {resource === 'students' ? (
          <>
            <p className="text-sm text-stone-600">
              Required: student_code, first_name, class_grade, class_section, starts_on, and at
              least one parent. Dates: YYYY-MM-DD. gender: MALE, FEMALE, OTHER or NOT_SPECIFIED.
            </p>
            <details className="rounded-xl border border-stone-200 p-3 text-sm">
              <summary className="cursor-pointer font-medium">
                All supported columns and parent instructions
              </summary>
              <p className="mt-3 break-words">
                Student and enrollment: {studentImportFields.join(', ')}
              </p>
              <p className="mt-3">
                For parents 1–2, use parent_1_ and parent_2_ with these fields:{' '}
                {guardianImportFields.join(', ')}.
              </p>
              <p className="mt-3">
                NEW requires a full_name. To link an existing parent, set mode to EXISTING, enter
                their email, and leave full_name and phone blank. For siblings in one file, add the
                parent as NEW in the first row, then EXISTING in later rows.
              </p>
              <p className="mt-3">
                Blank mode means NEW. Relationship: MOTHER, FATHER, GUARDIAN or OTHER. Use
                true/false for contact and alert flags. Parent 1 is primary by default; choose at
                most one primary contact. Blank unused parent groups are ignored.
              </p>
              <p className="mt-3">
                Use an existing class grade and section. Blank academic_session uses the current
                session. Optional fields may be blank. No accounts, invitations or passwords are
                created by importing.
              </p>
            </details>
          </>
        ) : (
          <p className="break-all text-sm">Columns: {columns[resource]}</p>
        )}
        {excelKind && (
          <p className="text-sm text-stone-600">
            Accepts CSV or Excel (.xlsx). Put the import headers on the first worksheet and format
            ID columns as Text to keep leading zeros. Upload photos separately using Import photo
            ZIP.
          </p>
        )}
        <label className="field-label block">
          {excelKind ? 'CSV or Excel file' : 'CSV file'}
          <input
            className="input mt-2"
            type="file"
            disabled={pending}
            accept={excelKind ? '.csv,.xlsx,text/csv' : '.csv,text/csv'}
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              if (file) void loadFile(file);
            }}
          />
        </label>
        <label className="field-label block">
          CSV preview
          <textarea
            className="input mt-2 min-h-44 font-mono text-xs"
            value={text}
            disabled={pending}
            onChange={(e) => change(e.target.value)}
            placeholder={columns[resource]}
          />
        </label>
        <p className="text-xs text-stone-600">
          {resource === 'students'
            ? 'The entire file saves together. If any row is invalid, nothing is imported. Existing students are never overwritten.'
            : 'Parent links use student codes and unique parent emails. Teacher assignments use staff codes and the current class grade/section. Empty optional cells are omitted.'}
        </p>
        {progress && (
          <section
            aria-label="Import progress"
            className="rounded-xl border border-stone-200 bg-stone-50 p-4"
          >
            <p aria-live="polite" aria-atomic="true" className="text-sm font-medium text-ink">
              {progressLabel}
            </p>
            <div
              role="progressbar"
              aria-label="CSV import progress"
              aria-valuemin={0}
              aria-valuemax={2}
              aria-valuenow={pending ? undefined : completedSteps}
              aria-valuetext={progressLabel}
              className="my-3 h-2 overflow-hidden rounded-full bg-stone-200"
            >
              <div
                className={`h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none ${pending ? 'bg-lime-500/50 motion-safe:animate-pulse' : 'bg-lime-500'}`}
                style={{ width: pending ? '100%' : `${completedSteps * 50}%` }}
              />
            </div>
            <ol className="flex justify-between gap-3 text-xs text-stone-600">
              <li>{completedSteps >= 1 ? '✓ ' : '1. '}Validate file</li>
              <li>{completedSteps === 2 ? '✓ ' : '2. '}Import records</li>
            </ol>
            {pending && (
              <p className="mt-3 text-xs text-stone-600">
                Keep this page open. All records save together.
              </p>
            )}
          </section>
        )}
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
        {validated && !pending && <p role="status">All rows validated. Ready to import.</p>}
        {result && (
          <p role="status">
            {result}
            {excelKind ? ' 0 failed records.' : ''}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={pending} onClick={requestClose}>
            Close
          </Button>
          <Button variant="outline" disabled={pending || !text} onClick={() => submit(false)}>
            {progress?.stage === 'validating' && pending ? 'Validating…' : 'Validate file'}
          </Button>
          <Button variant="lime" disabled={pending || !validated} onClick={() => submit(true)}>
            {progress?.stage === 'importing' && pending ? 'Importing…' : 'Import validated records'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
