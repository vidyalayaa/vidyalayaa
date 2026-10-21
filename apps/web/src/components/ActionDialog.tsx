import { useState, useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, useAuth, HttpError } from '../lib/auth';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { label, fromDateTimeLocal } from '../lib/utils';
import { readDraft, saveDraft, deleteDraft } from '../lib/drafts';
import { useUnsavedChanges } from '../lib/use-unsaved-changes';
import RecordSelect from './RecordSelect';
export interface ActionField {
  key: string;
  type?: string;
  options?: string[];
  optional?: boolean;
  default?: string;
  lookup?: string;
  nullable?: boolean;
}
export function ActionDialog({
  open,
  close,
  title,
  endpoint,
  fields,
  method = 'POST',
  onResult,
  timezone,
}: {
  open: boolean;
  close: () => void;
  title: string;
  endpoint: string;
  fields: ActionField[];
  method?: string;
  timezone?: string;
  onResult?: (r: Record<string, unknown>) => void;
}) {
  const a = useAuth(),
    qc = useQueryClient(),
    [error, setError] = useState(''),
    [dirty, setDirty] = useState(false),
    formRef = useRef<HTMLFormElement>(null),
    request = useRef({ body: '', key: '' });
  const draftKey = `${a.me?.id}:${a.school}:action:${endpoint}:${fields
    .filter((f) => f.type === 'hidden')
    .map((f) => f.default)
    .join(':')}`;
  const draft = readDraft(draftKey);
  useUnsavedChanges(open && dirty);
  useEffect(() => {
    if (open) setDirty(Object.keys(readDraft(draftKey)).length > 0);
  }, [open, draftKey]);
  const requestClose = () => {
    if (!dirty || window.confirm('Close with unsaved changes? The draft stays only in this tab.')) {
      setDirty(false);
      close();
    }
  };
  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => {
      const encoded = JSON.stringify(body);
      if (request.current.body !== encoded)
        request.current = { body: encoded, key: crypto.randomUUID() };
      return api(endpoint, {
        method,
        headers: { 'Idempotency-Key': request.current.key },
        body: encoded,
      });
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: [a.school] });
      await onResult?.(r);
      setDirty(false);
      deleteDraft(draftKey);
      close();
    },
    onError: (e) => {
      const err = e as Partial<HttpError>;
      if (Array.isArray(err.details) && err.details.length) {
        const issues = (err.details as Array<{ path?: (string | number)[]; message?: string }>)
          .map((i) => {
            const field = i.path?.length ? label(String(i.path[i.path.length - 1])) : '';
            return field ? `${field}: ${i.message}` : i.message;
          })
          .filter(Boolean);
        setError(issues.join('. ') || err.message || 'Validation error');
      } else {
        setError(err.message || 'The request failed.');
      }
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) requestClose();
      }}
      title={title}
    >
      <form
        key={draftKey}
        ref={formRef}
        onChange={(e) => {
          const values: Record<string, unknown> = {};
          const data = new FormData(e.currentTarget);
          for (const field of fields) {
            if (field.type === 'password') continue;
            values[field.key] =
              field.type === 'multiselect' ? data.getAll(field.key) : data.get(field.key);
          }
          saveDraft(draftKey, values);
          setDirty(true);
        }}
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
              if (field.optional && !value) {
                if (field.nullable) body[field.key] = null;
                continue;
              }
              body[field.key] =
                field.type === 'number'
                  ? Number(value)
                  : field.type === 'json'
                    ? JSON.parse(value)
                    : field.type === 'datetime-local'
                      ? fromDateTimeLocal(value, timezone || a.me?.school?.timezone)
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
                        defaultChecked={(Array.isArray(draft[field.key])
                          ? (draft[field.key] as string[])
                          : (JSON.parse(field.default || '[]') as string[])
                        ).includes(option)}
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
                  defaultValue={
                    typeof draft[field.key] === 'string' ? String(draft[field.key]) : field.default
                  }
                  optional={field.optional}
                  label={label(field.key.replace(/_id$/, ''))}
                />
              ) : field.options || field.type === 'boolean' ? (
                <select
                  id={`action-${field.key}`}
                  name={field.key}
                  className="input"
                  defaultValue={
                    typeof draft[field.key] === 'string' ? String(draft[field.key]) : field.default
                  }
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
                  defaultValue={
                    typeof draft[field.key] === 'string' ? String(draft[field.key]) : field.default
                  }
                  required={!field.optional}
                />
              ) : (
                <input
                  id={`action-${field.key}`}
                  className="input"
                  name={field.key}
                  type={field.type || 'text'}
                  defaultValue={
                    typeof draft[field.key] === 'string' ? String(draft[field.key]) : field.default
                  }
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
          <Button type="button" variant="outline" onClick={requestClose}>
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
