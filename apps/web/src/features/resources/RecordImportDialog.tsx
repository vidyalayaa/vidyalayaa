import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, useAuth, HttpError } from '../../lib/auth';
import { csvRecords, saveCsv } from '../../lib/csv';
import {
  studentImportColumns,
  studentImportFields,
  guardianImportFields,
} from '@vidyalayaa/contracts';
import { readDraft, saveDraft, deleteDraft } from '../../lib/drafts';
import { useUnsavedChanges } from '../../lib/use-unsaved-changes';
import { Dialog } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';

const columns = {
  students: studentImportColumns.join(','),
  parents: 'full_name,email,phone,account_email,status',
  teachers: 'staff_code,full_name,account_email,status',
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
    [result, setResult] = useState(''),
    idempotency = useRef(crypto.randomUUID());
  useUnsavedChanges(!!text && !result);
  function change(value: string) {
    setText(value);
    setError('');
    saveDraft(key, { text: value });
    setValidated(false);
    setResult('');
    idempotency.current = crypto.randomUUID();
  }
  async function submit(commit: boolean) {
    setPending(true);
    setError('');
    try {
      const rows = csvRecords(text, resource === 'students' ? studentImportColumns : undefined);
      const values =
        resource === 'students'
          ? rows
          : rows.map((row) =>
              Object.fromEntries(
                Object.entries(row).map(([key, value]) => [
                  key,
                  ['true', 'false'].includes(value.toLowerCase())
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
        setValidated(true);
        setResult('');
      }
    } catch (e) {
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
            : ''),
      );
      if (!commit || (e instanceof HttpError && e.status < 500 && ![408, 429].includes(e.status)))
        setValidated(false);
    } finally {
      setPending(false);
    }
  }
  const requestClose = () => {
    if (!text || window.confirm('Close this import? Its draft stays only in this tab.')) close();
  };
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
        <label className="field-label block">
          CSV file
          <input
            className="input mt-2"
            type="file"
            disabled={pending}
            accept=".csv,text/csv"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              if (f.size > 512000) {
                setError('Choose a CSV smaller than 500 KB.');
                setValidated(false);
                return;
              }
              try {
                change(await f.text());
              } catch {
                setError('The file could not be read. Choose the CSV again.');
                setValidated(false);
              }
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
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
        {validated && <p role="status">All rows validated. Ready to import.</p>}
        {result && <p role="status">{result}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={requestClose}>
            Close
          </Button>
          <Button variant="outline" disabled={pending || !text} onClick={() => submit(false)}>
            Validate file
          </Button>
          <Button variant="lime" disabled={pending || !validated} onClick={() => submit(true)}>
            {pending ? 'Working…' : 'Import validated records'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
