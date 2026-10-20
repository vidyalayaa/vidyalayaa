import { useState, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { bulkMarksSchema, type Page } from '@vidyalayaa/contracts';
import { parseCsv } from '../../lib/csv';
import { api, useAuth, HttpError } from '../../lib/auth';
import { readDraft, saveDraft, deleteDraft } from '../../lib/drafts';
import { useUnsavedChanges } from '../../lib/use-unsaved-changes';
import { ZodError } from 'zod';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
async function all(resource: string) {
  const rows: Record<string, unknown>[] = [];
  for (let page = 1; ; page++) {
    const r = await api<Page>(`/resources/${resource}?page_size=100&page=${page}`);
    rows.push(...r.data);
    if (rows.length >= r.total || !r.data.length) return rows;
  }
}
export default function BulkMarksDialog({ open, close }: { open: boolean; close: () => void }) {
  const a = useAuth();
  const draftKey = `${a.me?.id}:${a.school}:marks-import`,
    draft = readDraft(draftKey);
  const [csv, setCsv] = useState(String(draft.csv || '')),
    [exam, setExam] = useState(String(draft.exam || ''));
  const dirty = !!csv;
  useUnsavedChanges(open && dirty);
  useEffect(() => {
    saveDraft(draftKey, { csv, exam });
  }, [draftKey, csv, exam]);
  const requestClose = () => {
    if (!dirty || window.confirm('Close with unsaved marks? The draft stays only in this tab.'))
      close();
  };
  const qc = useQueryClient(),
    [error, setError] = useState(''),
    [rowErrors, setRowErrors] = useState<string[]>([]),
    [pending, setPending] = useState(false),
    idempotency = useRef(crypto.randomUUID());
  const exams = useQuery({
    queryKey: [a.school, 'exams', 'import'],
    queryFn: () => all('exams'),
    enabled: open,
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) requestClose();
      }}
      title="Import assessment marks"
      description="Upload up to 500 CSV rows. The complete upload is validated before any marks are saved."
    >
      <form
        className="space-y-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setError('');
          setRowErrors([]);
          if (!csv) return;
          const exam_id = String(new FormData(e.currentTarget).get('exam_id'));
          setPending(true);
          try {
            if (new Blob([csv]).size > 512000) throw new Error('Choose a CSV smaller than 500 KB.');
            const rows = parseCsv(csv),
              header = rows.shift()?.map((x) => x.trim().toLowerCase());
            if (!header || header.join(',') !== 'student_code,subject_code,score,remarks')
              throw new Error('Use columns: student_code,subject_code,score,remarks');
            if (rows.length > 500 || !rows.length)
              throw new Error('Include between 1 and 500 mark rows.');
            const [students, subjects] = await Promise.all([all('students'), all('subjects')]);
            const entries = rows.map((r, i) => {
              const student = students.find((s) => s.student_code === r[0]?.trim()),
                subject = subjects.find((s) => s.code === r[1]?.trim());
              if (!student || !subject || !r[2]?.trim())
                throw new Error(`Check student code, subject code and score at row ${i + 2}.`);
              return {
                student_id: student.id,
                subject_id: subject.id,
                score: Number(r[2]),
                remarks: r[3] || null,
              };
            });
            const body = bulkMarksSchema.parse({ exam_id, entries });
            await api('/marks/bulk', {
              method: 'POST',
              headers: { 'Idempotency-Key': idempotency.current },
              body: JSON.stringify(body),
            });
            qc.invalidateQueries({ queryKey: [a.school] });
            deleteDraft(draftKey);
            setCsv('');
            setExam('');
            close();
          } catch (e) {
            const issues =
              e instanceof ZodError
                ? e.issues
                : e instanceof HttpError && Array.isArray(e.details)
                  ? e.details
                  : [];
            setRowErrors(
              issues.map((issue: { path: (string | number)[]; message: string }) => {
                const index = issue.path.indexOf('entries'),
                  row = index >= 0 ? Number(issue.path[index + 1]) + 2 : undefined;
                return `${row ? `CSV row ${row}: ` : ''}${issue.message} (${issue.path.filter((x) => typeof x === 'string' && x !== 'entries').join(' / ')})`;
              }),
            );
            setError(
              e instanceof ZodError
                ? 'Check the highlighted CSV rows.'
                : (e as Error).message +
                    (e instanceof HttpError && e.requestId ? ` Reference: ${e.requestId}` : ''),
            );
          } finally {
            setPending(false);
          }
        }}
      >
        <div>
          <label className="field-label" htmlFor="import-exam">
            Open examination
          </label>
          <select
            id="import-exam"
            name="exam_id"
            className="input"
            required
            value={exam}
            onChange={(e) => {
              setExam(e.target.value);
              idempotency.current = crypto.randomUUID();
            }}
          >
            <option value="">Select an open exam</option>
            {exams.data
              ?.filter((x) => x.status === 'OPEN')
              .map((x) => (
                <option key={String(x.id)} value={String(x.id)}>
                  {String(x.name)}
                </option>
              ))}
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="marks-file">
            Marks CSV
          </label>
          <input
            id="marks-file"
            type="file"
            accept=".csv,text/csv"
            className="input"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 512000) {
                setError('Choose a CSV smaller than 500 KB.');
                return;
              }
              setCsv(await file.text());
              idempotency.current = crypto.randomUUID();
            }}
          />
          {csv && (
            <p role="status" className="mt-2 text-sm">
              CSV draft retained in this tab. Select a file to replace it.
            </p>
          )}
          <p className="mt-3 text-xs text-stone-500">
            Columns: student_code, subject_code, score, remarks. Use the student and subject codes
            from your school records.
          </p>
        </div>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        {!!rowErrors.length && (
          <ul className="field-error list-disc pl-5" aria-label="CSV validation errors">
            {rowErrors.map((message, i) => (
              <li key={i}>{message}</li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={requestClose}>
            Cancel
          </Button>
          <Button variant="lime" disabled={pending}>
            {pending ? 'Validating & saving…' : 'Import marks'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
