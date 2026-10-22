import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  calendarEventSchema,
  calendarKinds,
  calendarKindLabels,
  type CalendarClass,
  type CalendarEvent,
} from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { useUnsavedChanges } from '../../lib/use-unsaved-changes';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { groupClasses } from './calendar-utils';

export default function EventForm({
  event,
  date,
  classes,
  close,
  saved,
}: {
  event?: CalendarEvent;
  date: string;
  classes: CalendarClass[];
  close: () => void;
  saved: () => void;
}) {
  const a = useAuth(),
    qc = useQueryClient();
  const [values, setValues] = useState({
    title: event?.title || '',
    description: event?.description || '',
    kind: event?.kind || 'SCHOOL_EVENT',
    start_date: event?.start_date || date,
    end_date: event?.end_date || date,
    audience: event?.audience || 'SCHOOL',
    class_ids: event?.class_ids || [],
  });
  const [dirty, setDirty] = useState(false),
    [search, setSearch] = useState('');
  const retry = useRef({ body: '', key: crypto.randomUUID() });
  useUnsavedChanges(dirty);
  const mutation = useMutation({
    mutationFn: async () => {
      const b = calendarEventSchema.parse(values),
        body = JSON.stringify({ ...b, ...(event ? { expected_version: event.version } : {}) });
      if (retry.current.body !== body) retry.current = { body, key: crypto.randomUUID() };
      return api(`/calendar/events${event ? '/' + event.id : ''}`, {
        method: event ? 'PATCH' : 'POST',
        headers: { 'Idempotency-Key': retry.current.key },
        body,
      });
    },
    onSuccess: async () => {
      setDirty(false);
      await qc.invalidateQueries({ queryKey: [a.school] });
      saved();
    },
  });
  const change = (key: string, value: string) => {
    setDirty(true);
    setValues((v) => {
      const next = { ...v, [key]: value };
      if (key === 'audience' && value === 'SCHOOL') next.class_ids = [];
      if (key === 'start_date' && (v.end_date === v.start_date || v.end_date < value))
        next.end_date = value;
      return next;
    });
  };
  const toggle = (ids: string[], selected: boolean) => {
    setDirty(true);
    setValues((v) => ({
      ...v,
      class_ids: selected
        ? [...new Set([...v.class_ids, ...ids])]
        : v.class_ids.filter((id) => !ids.includes(id)),
    }));
  };
  const requestClose = () => {
    if (!mutation.isPending && (!dirty || window.confirm('Discard unsaved event details?')))
      close();
  };
  const choices = [
    ...new Map([...classes, ...(event?.targets || [])].map((c) => [c.id, c])).values(),
  ];
  const error = mutation.error as Error & { issues?: { message: string }[] };
  return (
    <Dialog
      open
      title={event ? 'Edit calendar event' : 'Add calendar event'}
      description="Choose when the event happens and who should see it."
      onOpenChange={(v) => {
        if (!v) requestClose();
      }}
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
      >
        <fieldset disabled={mutation.isPending} className="min-w-0 space-y-5">
          <label className="block text-sm font-medium" htmlFor="event-title">
            Title
            <input
              id="event-title"
              className="input mt-2"
              value={values.title}
              required
              maxLength={200}
              onChange={(e) => change('title', e.target.value)}
            />
          </label>
          <label className="block text-sm font-medium" htmlFor="event-description">
            Description
            <textarea
              id="event-description"
              className="input mt-2 min-h-24"
              value={values.description}
              maxLength={10000}
              onChange={(e) => change('description', e.target.value)}
            />
          </label>
          <label className="block text-sm font-medium" htmlFor="event-kind">
            Event type
            <select
              id="event-kind"
              className="input mt-2"
              value={values.kind}
              onChange={(e) => change('kind', e.target.value)}
            >
              {calendarKinds.map((kind) => (
                <option key={kind} value={kind}>
                  {calendarKindLabels[kind]}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="text-sm font-medium" htmlFor="event-start">
              Start date
              <input
                id="event-start"
                type="date"
                className="input mt-2"
                required
                value={values.start_date}
                onChange={(e) => change('start_date', e.target.value)}
              />
            </label>
            <label className="text-sm font-medium" htmlFor="event-end">
              End date
              <input
                id="event-end"
                type="date"
                className="input mt-2"
                required
                min={values.start_date}
                value={values.end_date}
                onChange={(e) => change('end_date', e.target.value)}
              />
            </label>
          </div>
          <label className="block text-sm font-medium" htmlFor="event-audience">
            Target audience
            <select
              id="event-audience"
              className="input mt-2"
              value={values.audience}
              onChange={(e) => change('audience', e.target.value)}
            >
              <option value="SCHOOL">Entire school</option>
              <option value="CLASSES">Specific classes and sections</option>
            </select>
          </label>
          {values.audience === 'CLASSES' && (
            <section
              aria-label="Event class and section targets"
              className="space-y-3 rounded-xl border border-stone-200 p-4"
            >
              <p className="text-sm text-stone-600">
                Select a class for all its listed sections, or choose individual sections.{' '}
                {values.class_ids.length} selected.
              </p>
              <label className="block text-sm" htmlFor="event-class-search">
                Find a class or section
                <input
                  id="event-class-search"
                  className="input mt-2"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Class, section or academic session"
                />
              </label>
              <div className="max-h-72 space-y-4 overflow-y-auto pr-1">
                {groupClasses(choices).map(([key, rows]) => {
                  const match = rows.filter((c) =>
                    `class ${c.grade} section ${c.section} ${c.session_name}`
                      .toLowerCase()
                      .includes(search.toLowerCase().trim()),
                  );
                  if (!match.length) return null;
                  const ids = rows.map((c) => c.id),
                    all = ids.every((id) => values.class_ids.includes(id)),
                    some = ids.some((id) => values.class_ids.includes(id));
                  return (
                    <fieldset key={key} className="rounded-lg bg-stone-50 p-3">
                      <legend className="px-1 text-sm font-semibold">
                        Class {rows[0].grade} · {rows[0].session_name}
                      </legend>
                      <label className="mb-3 flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={all}
                          ref={(el) => {
                            if (el) el.indeterminate = some && !all;
                          }}
                          onChange={(e) => toggle(ids, e.target.checked)}
                        />{' '}
                        All sections of Class {rows[0].grade} · {rows[0].session_name}
                      </label>
                      <div className="flex flex-wrap gap-x-5 gap-y-3">
                        {match.map((c) => (
                          <label key={c.id} className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              aria-label={`Class ${c.grade} Section ${c.section} · ${c.session_name}`}
                              checked={values.class_ids.includes(c.id)}
                              onChange={(e) => toggle([c.id], e.target.checked)}
                            />{' '}
                            Section {c.section}
                            {c.retired_at ? ' · Archived' : ''}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  );
                })}
                {!choices.length && (
                  <p className="text-sm text-stone-500">
                    No classes available. Add classes and sections in Academics first.
                  </p>
                )}
              </div>
            </section>
          )}
        </fieldset>
        {error && (
          <p role="alert" className="field-error">
            {error.issues?.map((i) => i.message).join(' ') || error.message}
          </p>
        )}
        <div className="flex justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={mutation.isPending}
            onClick={requestClose}
          >
            Cancel
          </Button>
          <Button type="submit" variant="lime" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save event'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
