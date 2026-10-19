import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, useAuth } from '../lib/auth';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { label, fromDateTimeLocal } from '../lib/utils';
import RecordSelect from './RecordSelect';
export interface ActionField {
  key: string;
  type?: string;
  options?: string[];
  optional?: boolean;
  default?: string;
  lookup?: string;
}
export function ActionDialog({
  open,
  close,
  title,
  endpoint,
  fields,
  method = 'POST',
  onResult,
}: {
  open: boolean;
  close: () => void;
  title: string;
  endpoint: string;
  fields: ActionField[];
  method?: string;
  onResult?: (r: Record<string, unknown>) => void;
}) {
  const a = useAuth(),
    qc = useQueryClient(),
    [error, setError] = useState('');
  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(endpoint, {
        method,
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(body),
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: [a.school] });
      onResult?.(r);
      close();
    },
    onError: (e) => setError(e.message),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) close();
      }}
      title={title}
    >
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          const f = new FormData(e.currentTarget),
            body: Record<string, unknown> = {};
          try {
            for (const field of fields) {
              if (field.type === 'multiselect') {
                body[field.key] = f.getAll(field.key).map(String);
                continue;
              }
              const value = String(f.get(field.key) || '');
              if (field.optional && !value) continue;
              body[field.key] =
                field.type === 'number'
                  ? Number(value)
                  : field.type === 'json'
                    ? JSON.parse(value)
                    : field.type === 'datetime-local'
                      ? fromDateTimeLocal(value, a.me?.school?.timezone)
                      : field.type === 'boolean'
                        ? value === 'true'
                        : value;
            }
            mutation.mutate(body);
          } catch (error) {
            setError(
              error instanceof SyntaxError
                ? 'Check the JSON fields before saving.'
                : (error as Error).message,
            );
          }
        }}
      >
        {fields.map((field) =>
          field.type === 'hidden' ? (
            <input key={field.key} name={field.key} type="hidden" value={field.default || ''} />
          ) : (
            <div
              key={field.key}
              className={['textarea', 'json'].includes(field.type || '') ? 'col-span-full' : ''}
            >
              <label
                className="field-label"
                id={`action-${field.key}-label`}
                htmlFor={field.type === 'multiselect' ? undefined : `action-${field.key}`}
              >
                {label(field.key.replace(/_id$/, ''))}
                {field.optional && <span>optional</span>}
              </label>
              {field.type === 'multiselect' ? (
                <fieldset
                  aria-labelledby={`action-${field.key}-label`}
                  className="grid grid-cols-2 gap-3"
                >
                  {field.options?.map((option) => (
                    <label key={option} className="flex gap-2 text-sm">
                      <input
                        type="checkbox"
                        name={field.key}
                        value={option}
                        defaultChecked={(JSON.parse(field.default || '[]') as string[]).includes(
                          option,
                        )}
                      />
                      {label(option)}
                    </label>
                  ))}
                </fieldset>
              ) : field.lookup ? (
                <RecordSelect
                  name={field.key}
                  id={`action-${field.key}`}
                  endpoint={field.lookup}
                  defaultValue={field.default}
                  optional={field.optional}
                  label={label(field.key.replace(/_id$/, ''))}
                />
              ) : field.options || field.type === 'boolean' ? (
                <select
                  id={`action-${field.key}`}
                  name={field.key}
                  className="input"
                  defaultValue={field.default}
                >
                  {(field.options || ['true', 'false']).map((o) => (
                    <option key={o} value={o}>
                      {o === 'en-IN'
                        ? 'English (India)'
                        : o === 'hi-IN'
                          ? 'हिन्दी (भारत)'
                          : label(o)}
                    </option>
                  ))}
                </select>
              ) : ['textarea', 'json'].includes(field.type || '') ? (
                <textarea
                  id={`action-${field.key}`}
                  name={field.key}
                  rows={5}
                  className="input"
                  defaultValue={field.default}
                  required={!field.optional}
                />
              ) : (
                <input
                  id={`action-${field.key}`}
                  className="input"
                  name={field.key}
                  type={field.type || 'text'}
                  defaultValue={field.default}
                  required={!field.optional}
                />
              )}
            </div>
          ),
        )}
        {error && (
          <p role="alert" className="field-error col-span-full">
            {error}
          </p>
        )}
        <div className="col-span-full flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button variant="lime" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
