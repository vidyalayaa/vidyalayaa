import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, useAuth, HttpError } from '../../lib/auth';
import { parseCsv } from '../../lib/csv';
import { readDraft, saveDraft, deleteDraft } from '../../lib/drafts';
import { useUnsavedChanges } from '../../lib/use-unsaved-changes';
import { Dialog } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';

const columns = {
  students: 'student_code,first_name,last_name,date_of_birth,account_email,status',
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
    key = `${a.me?.id}:${a.school}:import:${resource}`,
    [text, setText] = useState(() => String(readDraft(key).text || '')),
    [validated, setValidated] = useState(false),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false),
    [result, setResult] = useState(''),
    idempotency = useRef(crypto.randomUUID());
  useUnsavedChanges(!!text && !result);
  function change(value: string) {
    setText(value);
    saveDraft(key, { text: value });
    setValidated(false);
    setResult('');
    idempotency.current = crypto.randomUUID();
  }
  async function submit(commit: boolean) {
    setPending(true);
    setError('');
    try {
      const rows = parseCsv(text),
        header = rows.shift()?.map((h) => h.trim().toLowerCase());
      if (!header?.length || rows.length < 1 || rows.length > 500)
        throw new Error('Include a header and 1–500 records.');
      if (new Set(header).size !== header.length)
        throw new Error('Each column name must appear once.');
      const values = rows.map((row) =>
        Object.fromEntries(
          header.flatMap((h, i) =>
            row[i]?.trim()
              ? [
                  [
                    h,
                    ['true', 'false'].includes(row[i].trim().toLowerCase())
                      ? row[i].trim().toLowerCase() === 'true'
                      : row[i].trim(),
                  ],
                ]
              : [],
          ),
        ),
      );
      const r = await api<{ validated: number; imported: number }>(`/imports/${resource}`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotency.current },
        body: JSON.stringify({ rows: values, validate_only: !commit }),
      });
      if (commit) {
        setResult(`${r.imported} records imported.`);
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
                .map((x: { row: number; message: string }) => `CSV row ${x.row + 1}: ${x.message}`)
                .join('; ')
            : ''),
      );
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
      title="Import school records"
      description="Validate the whole file before saving. Account emails must already have accepted the matching school invitation."
    >
      <div className="space-y-4">
        <p className="break-all text-sm">Columns: {columns[resource]}</p>
        <label className="field-label block">
          CSV file
          <input
            className="input mt-2"
            type="file"
            accept=".csv,text/csv"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              if (f.size > 512000) {
                setError('Choose a CSV smaller than 500 KB.');
                return;
              }
              change(await f.text());
            }}
          />
        </label>
        <label className="field-label block">
          CSV preview
          <textarea
            className="input mt-2 min-h-44 font-mono text-xs"
            value={text}
            onChange={(e) => change(e.target.value)}
            placeholder={columns[resource]}
          />
        </label>
        <p className="text-xs text-stone-600">
          Parent links use student codes and unique parent emails. Teacher assignments use staff
          codes and the current class grade/section. Empty optional cells are omitted.
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
