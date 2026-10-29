import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { classSubjectSchema, type AcademicClass } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { readDraft, saveDraft, deleteDraft } from '../../lib/drafts';
import { useUnsavedChanges } from '../../lib/use-unsaved-changes';
import RecordSelect from '../../components/RecordSelect';
import { Dialog } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';

// This form saves the section subject and required teacher in one transaction.
// Cancelling cannot leave a newly created subject without its assignment.
export default function ClassSubjectForm({ c, close }: { c: AcademicClass; close: () => void }) {
  const a = useAuth(),
    qc = useQueryClient();
  const key = `vidyalayaa.draft.${a.me?.id}.${a.school}.section-subject.${c.id}`;
  const [values, setValues] = useState(() => {
    const saved = readDraft(key);
    return Object.fromEntries(
      Object.entries({
        mode: 'new',
        subject_id: '',
        code: '',
        name: '',
        teacher_id: '',
        starts_on: new Intl.DateTimeFormat('en-CA', {
          timeZone: a.me?.school?.timezone || 'Asia/Kolkata',
        }).format(new Date()),
        ends_on: '',
      }).map(([field, initial]) => [
        field,
        typeof saved[field] === 'string' ? (saved[field] as string) : initial,
      ]),
    );
  });
  const [dirty, setDirty] = useState(() => Object.keys(readDraft(key)).length > 0),
    [error, setError] = useState('');
  const retry = useRef({ body: '', key: crypto.randomUUID() });
  useUnsavedChanges(dirty);
  useEffect(() => {
    if (dirty) saveDraft(key, values);
  }, [dirty, key, values]);
  function change(field: string, value: string) {
    setValues((v) => ({ ...v, [field]: value }));
    setDirty(true);
  }
  const mutation = useMutation({
    mutationFn: async () => {
      const body = classSubjectSchema.parse({
        ...(values.mode === 'new'
          ? { subject: { code: values.code, name: values.name } }
          : { subject_id: values.subject_id }),
        teacher_id: values.teacher_id,
        starts_on: values.starts_on,
        ends_on: values.ends_on || null,
      });
      const encoded = JSON.stringify(body);
      if (retry.current.body !== encoded)
        retry.current = { body: encoded, key: crypto.randomUUID() };
      return api(`/academics/classes/${c.id}/subjects`, {
        method: 'POST',
        headers: { 'Idempotency-Key': retry.current.key },
        body: encoded,
      });
    },
    onSuccess: async () => {
      setDirty(false);
      deleteDraft(key);
      await qc.invalidateQueries({ queryKey: [a.school] });
      close();
    },
    onError: (e) => {
      const zod = e as Error & { issues?: { message: string }[] };
      setError(zod.issues?.map((i) => i.message).join(' ') || e.message);
    },
  });
  function requestClose() {
    if (
      !mutation.isPending &&
      (!dirty || window.confirm('Close with unsaved changes? The draft stays in this tab.'))
    )
      close();
  }
  return (
    <Dialog
      open
      title="Add subject & teacher"
      description={`Class ${c.grade} · Section ${c.section}. Choose the subject and its teacher together. Other sections keep their own assignments.`}
      onOpenChange={(v) => {
        if (!v) requestClose();
      }}
    >
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          mutation.mutate();
        }}
      >
        <fieldset disabled={mutation.isPending} className="col-span-full min-w-0 space-y-4">
          <label className="field-label block" htmlFor="subject-source">
            Subject choice
            <select
              id="subject-source"
              className="input mt-2"
              value={values.mode}
              onChange={(e) => change('mode', e.target.value)}
            >
              <option value="existing">Use this class's existing subject</option>
              <option value="new">Add a new subject to this class</option>
            </select>
          </label>
          {values.mode === 'new' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="field-label block" htmlFor="code">
                Subject code
                <input
                  id="code"
                  className="input mt-2"
                  value={values.code}
                  onChange={(e) => change('code', e.target.value)}
                  required
                  maxLength={200}
                />
              </label>
              <label className="field-label block" htmlFor="name">
                Subject name
                <input
                  id="name"
                  className="input mt-2"
                  value={values.name}
                  onChange={(e) => change('name', e.target.value)}
                  required
                  maxLength={200}
                />
              </label>
            </div>
          ) : (
            <div>
              <label className="field-label" htmlFor="subject_id">
                Subject
              </label>
              <RecordSelect
                id="subject_id"
                name="subject_id"
                endpoint={`/academics/classes/${c.id}/subject-choices`}
                label="subject"
                value={values.subject_id}
                onChange={(v) => change('subject_id', v)}
              />
            </div>
          )}
          <div>
            <label className="field-label" htmlFor="teacher_id">
              Assigned teacher
            </label>
            <RecordSelect
              id="teacher_id"
              name="teacher_id"
              endpoint="/resources/teachers?assignable=1"
              label="teacher"
              value={values.teacher_id}
              onChange={(v) => change('teacher_id', v)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="field-label block" htmlFor="starts_on">
              Starts on
              <input
                id="starts_on"
                type="date"
                className="input mt-2"
                value={values.starts_on}
                onChange={(e) => change('starts_on', e.target.value)}
                required
              />
            </label>
            <label className="field-label block" htmlFor="ends_on">
              Ends on (optional)
              <input
                id="ends_on"
                type="date"
                className="input mt-2"
                value={values.ends_on}
                onChange={(e) => change('ends_on', e.target.value)}
              />
            </label>
          </div>
          <p className="text-sm text-stone-500">
            This subject is added to this section only. The teacher assignment is required.
          </p>
        </fieldset>
        {error && (
          <p className="field-error col-span-full" role="alert">
            {error}
          </p>
        )}
        <div className="col-span-full flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={mutation.isPending}
            onClick={requestClose}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="lime"
            disabled={
              mutation.isPending ||
              !values.teacher_id ||
              (values.mode === 'existing'
                ? !values.subject_id
                : !values.code.trim() || !values.name.trim())
            }
          >
            {mutation.isPending ? 'Saving…' : 'Save subject & teacher'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
