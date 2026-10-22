import { useState, useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { studentAdmissionSchema } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { readDraft, saveDraft, deleteDraft } from '../../lib/drafts';
import { useUnsavedChanges } from '../../lib/use-unsaved-changes';
import { Dialog } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import RecordSelect from '../../components/RecordSelect';

type Guardian = {
  mode: string;
  parent_id: string;
  full_name: string;
  email: string;
  phone: string;
  relationship: string;
  is_primary_contact: boolean;
  can_receive_alerts: boolean;
};
const guardian = (primary = false): Guardian => ({
  mode: 'new',
  parent_id: '',
  full_name: '',
  email: '',
  phone: '',
  relationship: 'GUARDIAN',
  is_primary_contact: primary,
  can_receive_alerts: true,
});
export default function StudentAdmissionForm({
  close,
  presetClass = '',
  done,
}: {
  close: () => void;
  presetClass?: string;
  done?: (id: string) => void;
}) {
  const a = useAuth(),
    qc = useQueryClient(),
    key = `vidyalayaa.draft.${a.me?.id}.${a.school}.admission.${presetClass || 'new'}`;
  const initial = () => ({
    student_code: '',
    first_name: '',
    last_name: '',
    email: '',
    date_of_birth: '',
    sex: 'NOT_SPECIFIED',
    status: 'ACTIVE',
    class_id: presetClass,
    roll_number: '',
    starts_on: new Intl.DateTimeFormat('en-CA', {
      timeZone: a.me?.school?.timezone || 'Asia/Kolkata',
    }).format(new Date()),
    ends_on: '',
  });
  const [values, setValues] = useState<Record<string, string>>(() => {
    const saved = readDraft(key);
    return Object.fromEntries(
      Object.entries(initial()).map(([k, v]) => [k, typeof saved[k] === 'string' ? saved[k] : v]),
    );
  });
  const [guardians, setGuardians] = useState<Guardian[]>(() => {
    const saved = readDraft(key).guardians;
    return Array.isArray(saved) && saved.length ? (saved as Guardian[]) : [guardian(true)];
  });
  const [dirty, setDirty] = useState(() => Object.keys(readDraft(key)).length > 0),
    [error, setError] = useState('');
  const retry = useRef({ body: '', key: crypto.randomUUID() });
  useUnsavedChanges(dirty);
  useEffect(() => {
    if (dirty) saveDraft(key, { ...values, guardians });
  }, [dirty, key, values, guardians]);
  const change = (k: string, v: string) => {
    setValues((old) => ({ ...old, [k]: v }));
    setDirty(true);
  };
  function updateGuardian(i: number, k: keyof Guardian, v: string | boolean) {
    setGuardians((old) =>
      old.map((g, n) =>
        n === i
          ? { ...g, [k]: v }
          : k === 'is_primary_contact' && v
            ? { ...g, is_primary_contact: false }
            : g,
      ),
    );
    setDirty(true);
  }
  const mutation = useMutation({
    mutationFn: async () => {
      const body = studentAdmissionSchema.parse({
        student: {
          student_code: values.student_code,
          first_name: values.first_name,
          last_name: values.last_name || null,
          email: values.email || null,
          date_of_birth: values.date_of_birth || null,
          sex: values.sex,
          status: values.status,
        },
        enrollment: {
          class_id: values.class_id,
          roll_number: values.roll_number || null,
          starts_on: values.starts_on,
          ends_on: values.ends_on || null,
        },
        guardians: guardians.map((g) => ({
          ...(g.mode === 'existing'
            ? { parent_id: g.parent_id }
            : {
                parent: { full_name: g.full_name, email: g.email || null, phone: g.phone || null },
              }),
          relationship: g.relationship,
          is_primary_contact: g.is_primary_contact,
          can_receive_alerts: g.can_receive_alerts,
        })),
      });
      const encoded = JSON.stringify(body);
      if (retry.current.body !== encoded)
        retry.current = { body: encoded, key: crypto.randomUUID() };
      return api<{ student: { id: string } }>('/student-directory/admissions', {
        method: 'POST',
        headers: { 'Idempotency-Key': retry.current.key },
        body: encoded,
      });
    },
    onSuccess: async (data) => {
      setDirty(false);
      deleteDraft(key);
      await qc.invalidateQueries({ queryKey: [a.school] });
      close();
      done?.(data.student.id);
    },
    onError: (e) => {
      const v = e as Error & { issues?: { message: string }[] };
      setError(v.issues?.map((i) => i.message).join(' ') || e.message);
    },
  });
  const requestClose = () => {
    if (
      !mutation.isPending &&
      (!dirty || window.confirm('Close with unsaved details? Your draft stays in this tab.'))
    )
      close();
  };
  const input = (id: string, title: string, type = 'text', required = false) => (
    <label key={id} className="block text-sm font-medium" htmlFor={id}>
      {title}
      <input
        className="input mt-2"
        id={id}
        type={type}
        required={required}
        value={values[id]}
        maxLength={type === 'text' ? 200 : undefined}
        onChange={(e) => change(id, e.target.value)}
      />
    </label>
  );
  return (
    <Dialog
      open
      title="Add student & family"
      description="Enter student, class and parent details together. Family connections are created automatically when you save."
      onOpenChange={(v) => {
        if (!v) requestClose();
      }}
    >
      <form
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          mutation.mutate();
        }}
      >
        <fieldset disabled={mutation.isPending} className="min-w-0 space-y-6">
          <section aria-label="Student details">
            <h3 className="mb-4 font-semibold">Student details</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              {input('student_code', 'Student code', 'text', true)}
              {input('first_name', 'First name', 'text', true)}
              {input('last_name', 'Last name')}
              {input('email', 'Student email (optional)', 'email')}
              {input('date_of_birth', 'Date of birth', 'date')}
              <label className="block text-sm font-medium" htmlFor="sex">
                Sex
                <select
                  id="sex"
                  className="input mt-2"
                  value={values.sex}
                  onChange={(e) => change('sex', e.target.value)}
                >
                  <option value="NOT_SPECIFIED">Not specified</option>
                  <option value="MALE">Male</option>
                  <option value="FEMALE">Female</option>
                  <option value="OTHER">Other</option>
                </select>
              </label>
              <label className="block text-sm font-medium" htmlFor="status">
                Status
                <select
                  id="status"
                  className="input mt-2"
                  value={values.status}
                  onChange={(e) => change('status', e.target.value)}
                >
                  {['ACTIVE', 'TRANSFERRED', 'GRADUATED', 'WITHDRAWN'].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
            </div>
          </section>
          <section aria-label="Class enrollment">
            <h3 className="mb-4 font-semibold">Class & section</h3>
            <label className="mb-2 block text-sm font-medium" htmlFor="class_id">
              Class and section
            </label>
            <RecordSelect
              name="class_id"
              endpoint="/student-directory/enrollment-classes"
              label="class and section"
              value={values.class_id}
              onChange={(v) => change('class_id', v)}
            />
            <p className="mt-2 text-xs text-stone-500">
              The academic session comes from the selected class.
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {input('roll_number', 'Roll number')}
              {input('starts_on', 'Enrollment starts on', 'date', true)}
              {input('ends_on', 'Enrollment ends on (optional)', 'date')}
            </div>
          </section>
          <section aria-label="Parents and family connections">
            <h3 className="mb-4 font-semibold">Parents & family connections</h3>
            <div className="space-y-4">
              {guardians.map((g, i) => (
                <section
                  key={i}
                  className="rounded-xl border border-stone-200 bg-stone-50 p-4"
                  aria-label={`Parent ${i + 1}`}
                >
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <h4 className="font-medium">Parent / guardian {i + 1}</h4>
                    {guardians.length > 1 && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setGuardians((old) => old.filter((_, n) => n !== i));
                          setDirty(true);
                        }}
                      >
                        Remove parent {i + 1}
                      </Button>
                    )}
                  </div>
                  <label className="block text-sm" htmlFor={`parent-${i}-mode`}>
                    Parent details
                    <select
                      id={`parent-${i}-mode`}
                      className="input mt-2"
                      value={g.mode}
                      onChange={(e) => updateGuardian(i, 'mode', e.target.value)}
                    >
                      <option value="new">Add a new parent</option>
                      <option value="existing">
                        Use an existing parent (e.g. a sibling's guardian)
                      </option>
                    </select>
                  </label>
                  {g.mode === 'existing' ? (
                    <div className="mt-4">
                      <label className="mb-2 block text-sm" htmlFor={`parent-${i}-id`}>
                        Existing parent
                      </label>
                      <RecordSelect
                        name={`parent-${i}-id`}
                        endpoint="/student-directory/parents"
                        label={`parent ${i + 1}`}
                        value={g.parent_id}
                        onChange={(v) => updateGuardian(i, 'parent_id', v)}
                      />
                    </div>
                  ) : (
                    <div className="mt-4 grid gap-4 sm:grid-cols-2">
                      {(['full_name', 'email', 'phone'] as const).map((k) => (
                        <label key={k} htmlFor={`parent-${i}-${k}`} className="block text-sm">
                          {k === 'full_name'
                            ? 'Parent full name'
                            : k === 'email'
                              ? 'Parent email (optional)'
                              : 'Parent phone (optional)'}
                          <input
                            id={`parent-${i}-${k}`}
                            className="input mt-2"
                            type={k === 'email' ? 'email' : k === 'phone' ? 'tel' : 'text'}
                            maxLength={k === 'phone' ? 30 : k === 'email' ? 254 : 200}
                            required={k === 'full_name'}
                            value={g[k]}
                            onChange={(e) => updateGuardian(i, k, e.target.value)}
                          />
                        </label>
                      ))}
                    </div>
                  )}
                  <label className="mt-4 block text-sm" htmlFor={`parent-${i}-relationship`}>
                    Relationship
                    <select
                      id={`parent-${i}-relationship`}
                      className="input mt-2"
                      value={g.relationship}
                      onChange={(e) => updateGuardian(i, 'relationship', e.target.value)}
                    >
                      {['MOTHER', 'FATHER', 'GUARDIAN', 'OTHER'].map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  </label>
                  <label className="mt-3 flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={g.is_primary_contact}
                      onChange={(e) => updateGuardian(i, 'is_primary_contact', e.target.checked)}
                    />
                    Primary contact
                  </label>
                  <label className="mt-3 flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={g.can_receive_alerts}
                      onChange={(e) => updateGuardian(i, 'can_receive_alerts', e.target.checked)}
                    />
                    May receive student alerts
                  </label>
                </section>
              ))}
            </div>
            {guardians.length < 5 && (
              <Button
                className="mt-3"
                type="button"
                variant="outline"
                onClick={() => {
                  setGuardians((old) => [...old, guardian()]);
                  setDirty(true);
                }}
              >
                Add another parent
              </Button>
            )}
            <p className="mt-3 text-xs text-stone-500">
              Save the family first. Account invitations can then be sent from Members &
              invitations.
            </p>
          </section>
        </fieldset>
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={mutation.isPending}
            onClick={requestClose}
          >
            Cancel
          </Button>
          <Button type="submit" variant="lime" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save student & family'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
