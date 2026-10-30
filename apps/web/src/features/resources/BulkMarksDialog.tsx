import { useState, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type Page } from '@vidyalayaa/contracts';
import { saveCsv } from '../../lib/csv';
import { marksTemplate, parseMarksSheet } from '../../lib/marks-entry';
import { useMarksEntrySheet } from '../../lib/use-marks-entry-sheet';
import { api, useAuth, HttpError } from '../../lib/auth';
import { readDraft, saveDraft, deleteDraft } from '../../lib/drafts';
import { useUnsavedChanges } from '../../lib/use-unsaved-changes';
import { ZodError } from 'zod';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
async function all(resource: string) {
  const rows: Record<string, unknown>[] = [];
  for (let page = 1; ; page++) {
    const r = await api<Page>(
      `/resources/${resource}${resource.includes('?') ? '&' : '?'}page_size=100&page=${page}`,
    );
    rows.push(...r.data);
    if (rows.length >= r.total || !r.data.length) return rows;
  }
}
export default function BulkMarksDialog({
  open,
  close,
  examId,
}: {
  open: boolean;
  close: () => void;
  examId?: string;
}) {
  const a = useAuth();
  const draftKey = `${a.me?.id}:${a.school}:marks-import${examId ? ':' + examId : ''}`,
    draft = readDraft(draftKey);
  const [csv, setCsv] = useState(String(draft.csv || '')),
    [exam, setExam] = useState(examId || String(draft.exam || '')),
    [subject, setSubject] = useState(''),
    [batch, setBatch] = useState(0);
  const sheet = useMarksEntrySheet(exam),
    selectedSubject =
      sheet.data?.subjects.find((s) => s.id === subject)?.id || sheet.data?.subjects[0]?.id || '';
  const dirty = !!csv;
  useUnsavedChanges(open && dirty);
  useEffect(() => {
    saveDraft(draftKey, { csv, exam });
  }, [draftKey, csv, exam]);
  const requestClose = () => {
    if (pending) return;
    if (!dirty || window.confirm('Close with unsaved marks? The draft stays only in this tab.'))
      close();
  };
  const qc = useQueryClient(),
    [error, setError] = useState(''),
    [rowErrors, setRowErrors] = useState<string[]>([]),
    [pending, setPending] = useState(false),
    idempotency = useRef(crypto.randomUUID());
  const exams = useQuery({
    queryKey: [a.school, 'exams', 'import', examId],
    queryFn: async () =>
      examId ? [await api<Record<string, unknown>>('/resources/exams/' + examId)] : all('exams'),
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
          const exam_id = examId || String(new FormData(e.currentTarget).get('exam_id'));
          setPending(true);
          let sourceRows: number[] = [];
          try {
            if (new Blob([csv]).size > 512000) throw new Error('Choose a CSV smaller than 500 KB.');
            if (!sheet.data || sheet.data.exam.id !== exam_id)
              throw new Error('Wait for the selected examination roster to load.');
            const parsed = parseMarksSheet(csv, sheet.data),
              body = parsed.body;
            sourceRows = parsed.sourceRows;
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
                  row = index >= 0 ? sourceRows[Number(issue.path[index + 1])] : undefined;
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
            disabled={!!examId || pending}
            value={exam}
            onChange={(e) => {
              setExam(e.target.value);
              setCsv('');
              setError('');
              setSubject('');
              setBatch(0);
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
        {sheet.error && (
          <p className="field-error" role="alert">
            {sheet.error.message}
          </p>
        )}
        {sheet.data && (
          <section
            className="rounded-xl border border-stone-200 bg-stone-50 p-4 space-y-3"
            aria-label="Download class marks sheet"
          >
            <p className="text-sm">
              Class {sheet.data.classroom.grade} · Section {sheet.data.classroom.section} ·{' '}
              {sheet.data.students.length} students · Maximum {sheet.data.exam.max_score}
            </p>
            <label className="field-label block">
              Template subject
              <select
                className="input mt-2"
                value={selectedSubject}
                disabled={pending}
                onChange={(e) => setSubject(e.target.value)}
              >
                {sheet.data.subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.code}
                  </option>
                ))}
              </select>
            </label>
            {sheet.data.students.length > 500 && (
              <label className="field-label block">
                CSV batch
                <select
                  className="input mt-2"
                  value={batch}
                  disabled={pending}
                  onChange={(e) => setBatch(Number(e.target.value))}
                >
                  {Array.from({ length: Math.ceil(sheet.data.students.length / 500) }, (_, i) => (
                    <option key={i} value={i}>
                      Students {i * 500 + 1}–{Math.min((i + 1) * 500, sheet.data!.students.length)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={pending || !selectedSubject || !sheet.data.students.length}
              onClick={() => {
                const data = sheet.data!;
                saveCsv(
                  new Blob([marksTemplate(data, selectedSubject, batch)], {
                    type: 'text/csv;charset=utf-8',
                  }),
                  `vidyalayaa-marks-${data.exam.id}-${selectedSubject}-batch-${batch + 1}.csv`,
                );
              }}
            >
              Download filled CSV template
            </Button>
            <p className="text-xs text-stone-600">
              Student details, roll numbers and subjects are filled in. Enter scores, keep the other
              details unchanged, then upload. Existing marks are included. Blank scores are skipped;
              enter 0 only for an actual zero score. Keep code and roll-number columns as Text in
              spreadsheet apps. Numeric codes with dropped leading zeros are accepted only when they
              match one authorized record.
            </p>
          </section>
        )}
        <div>
          <label className="field-label" htmlFor="marks-file">
            Marks CSV
          </label>
          <input
            id="marks-file"
            type="file"
            accept=".csv,text/csv"
            className="input"
            disabled={pending || sheet.isLoading || !!sheet.error}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 512000) {
                setCsv('');
                setError('Choose a CSV smaller than 500 KB.');
                return;
              }
              try {
                setCsv(await file.text());
                setError('');
                setRowErrors([]);
                idempotency.current = crypto.randomUUID();
              } catch {
                setError('The file could not be read. Choose the CSV again.');
              }
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
          <Button type="button" variant="outline" disabled={pending} onClick={requestClose}>
            {pending ? 'Saving…' : 'Cancel'}
          </Button>
          <Button variant="lime" disabled={pending || !csv || !sheet.data || !!sheet.error}>
            {pending ? 'Validating & saving…' : 'Import marks'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
