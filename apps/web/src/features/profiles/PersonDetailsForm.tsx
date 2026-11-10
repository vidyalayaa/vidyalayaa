import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PersonKind, StaffDetails, StudentContact } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { Button } from '../../components/ui/button';

const contactFields = [
  { key: 'contact_phone', label: 'Contact number', type: 'tel', max: 40 },
  { key: 'address', label: 'Address', type: 'textarea', max: 1200 },
] as const;
export const professionalFields = [
  { key: 'designation', label: 'Designation', type: 'text', max: 120 },
  { key: 'department', label: 'Department', type: 'text', max: 120 },
  { key: 'qualification', label: 'Qualification', type: 'text', max: 500 },
  { key: 'specialization', label: 'Specialization', type: 'text', max: 200 },
  { key: 'experience_years', label: 'Experience (years)', type: 'number', max: 80 },
  { key: 'joined_on', label: 'Joining date', type: 'date', max: 10 },
] as const;
export const emergencyFields = [
  { key: 'emergency_name', label: 'Emergency contact name', type: 'text', max: 200 },
  { key: 'emergency_relationship', label: 'Relationship', type: 'text', max: 100 },
  { key: 'emergency_phone', label: 'Emergency contact number', type: 'tel', max: 40 },
] as const;

export default function PersonDetailsForm({
  kind,
  id,
  initial,
  onDone,
}: {
  kind: PersonKind;
  id: string;
  initial: StaffDetails | StudentContact;
  onDone: () => void;
}) {
  const a = useAuth();
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const fields =
    kind === 'staff'
      ? [...professionalFields, ...contactFields, ...emergencyFields]
      : contactFields;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!a.me?.id || !a.school || pending) return;
    const data = Object.fromEntries(
      [...new FormData(event.currentTarget)].filter(([, value]) => value !== ''),
    );
    setPending(true);
    setError('');
    try {
      await api(
        `/profiles/${kind}/${id}`,
        {
          method: 'PATCH',
          body: JSON.stringify(data),
        },
        true,
        'json',
        { userId: a.me.id, schoolId: a.requestSchool },
      );
      await qc.invalidateQueries({ queryKey: [a.school] });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <fieldset disabled={pending} className="grid gap-4 sm:grid-cols-2">
        {fields.map(({ key, label, type, max }) => (
          <label
            key={key}
            className={
              type === 'textarea' ? 'field-label block sm:col-span-2' : 'field-label block'
            }
          >
            {label}
            {type === 'textarea' ? (
              <textarea
                className="input mt-2"
                name={key}
                maxLength={max}
                defaultValue={(initial as StaffDetails)[key]}
              />
            ) : (
              <input
                className="input mt-2"
                name={key}
                type={type}
                maxLength={max}
                min={type === 'number' ? 0 : undefined}
                max={type === 'number' ? max : undefined}
                step={type === 'number' ? 0.5 : undefined}
                defaultValue={(initial as StaffDetails)[key]}
              />
            )}
          </label>
        ))}
      </fieldset>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="lime" disabled={pending}>
          {pending ? 'Saving…' : 'Save profile details'}
        </Button>
        <Button type="button" variant="outline" disabled={pending} onClick={onDone}>
          Close editor
        </Button>
      </div>
    </form>
  );
}
