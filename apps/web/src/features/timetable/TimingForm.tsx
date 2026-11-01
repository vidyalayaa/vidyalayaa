import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { schoolTimingsSchema, type TimetableSettings } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { useUnsavedChanges } from '../../lib/use-unsaved-changes';
import { Dialog } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { generatePeriods, weekdays } from './timetable-utils';

export default function TimingForm({
  initial,
  close,
  endpoint = '/timetable/settings',
  onSaved,
}: {
  initial: TimetableSettings;
  close: () => void;
  endpoint?: string;
  onSaved?: () => Promise<unknown>;
}) {
  const a = useAuth(),
    qc = useQueryClient(),
    [settings, setSettings] = useState(() => structuredClone(initial.settings)),
    [expectedVersion] = useState(initial.version),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState('');
  const retry = useRef({ body: '', key: crypto.randomUUID() });
  useUnsavedChanges(dirty);
  const save = useMutation({
    mutationFn: () => {
      const value = schoolTimingsSchema.parse(settings),
        body = JSON.stringify({ expected_version: expectedVersion, settings: value });
      if (retry.current.body !== body) retry.current = { body, key: crypto.randomUUID() };
      return api(
        endpoint,
        {
          method: 'PUT',
          headers: { 'Idempotency-Key': retry.current.key },
          body,
        },
        true,
        'json',
        a.me ? { userId: a.me.id, schoolId: a.requestSchool } : undefined,
      );
    },
    onSuccess: async () => {
      setDirty(false);
      await qc.invalidateQueries({ queryKey: [a.school] });
      await onSaved?.();
      close();
    },
    onError: (e: Error & { issues?: { message: string }[] }) =>
      setError(e.issues?.map((i) => i.message).join(' ') || e.message),
  });
  const requestClose = () => {
    if (!save.isPending && (!dirty || window.confirm('Discard unsaved school timings?'))) close();
  };
  const change = (next: typeof settings) => {
    setSettings(next);
    setDirty(true);
    setError('');
  };
  return (
    <Dialog
      open
      title="School timings"
      description="Set school days, lectures and breaks. Existing lectures keep their times; edit a lecture to move it to a new period."
      onOpenChange={(v) => {
        if (!v) requestClose();
      }}
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          save.mutate();
        }}
      >
        <fieldset disabled={save.isPending} className="min-w-0 space-y-5">
          <fieldset className="flex flex-wrap gap-3">
            <legend className="mb-2 text-sm font-medium">School days</legend>
            {weekdays.map((day, i) => (
              <label className="flex items-center gap-2 text-sm" key={day}>
                <input
                  type="checkbox"
                  checked={settings.days.includes(i + 1)}
                  onChange={(e) =>
                    change({
                      ...settings,
                      days: e.target.checked
                        ? [...settings.days, i + 1].sort((a, b) => a - b)
                        : settings.days.filter((d) => d !== i + 1),
                    })
                  }
                />
                {day}
              </label>
            ))}
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="text-sm" htmlFor="school-start">
              School start
              <input
                className="input mt-2"
                id="school-start"
                type="time"
                required
                value={settings.start_time}
                onChange={(e) => change({ ...settings, start_time: e.target.value })}
              />
            </label>
            <label className="text-sm" htmlFor="lecture-duration">
              Lecture duration (minutes)
              <input
                className="input mt-2"
                id="lecture-duration"
                type="number"
                min="5"
                max="180"
                required
                value={settings.lecture_duration}
                onChange={(e) => change({ ...settings, lecture_duration: Number(e.target.value) })}
              />
            </label>
            <label className="text-sm" htmlFor="lecture-count">
              Number of lectures
              <input
                className="input mt-2"
                id="lecture-count"
                type="number"
                min="1"
                max="16"
                required
                value={settings.lecture_count}
                onChange={(e) => change({ ...settings, lecture_count: Number(e.target.value) })}
              />
            </label>
          </div>
          <section aria-label="School breaks" className="space-y-3">
            <h3 className="font-semibold">Breaks</h3>
            {settings.breaks.map((b, i) => (
              <fieldset key={i} className="grid gap-2 rounded-xl border p-3 sm:grid-cols-2">
                <legend className="px-1 text-sm">Break {i + 1}</legend>
                {(['label', 'start_time', 'end_time'] as const).map((k) => (
                  <label key={k} className="text-sm" htmlFor={`break-${i}-${k}`}>
                    {k === 'label'
                      ? 'Break name'
                      : k === 'start_time'
                        ? 'Break start'
                        : 'Break end'}
                    <input
                      id={`break-${i}-${k}`}
                      className="input mt-1"
                      required
                      maxLength={80}
                      type={k === 'label' ? 'text' : 'time'}
                      value={b[k]}
                      onChange={(e) =>
                        change({
                          ...settings,
                          breaks: settings.breaks.map((v, n) =>
                            n === i ? { ...v, [k]: e.target.value } : v,
                          ),
                        })
                      }
                    />
                  </label>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  aria-label={`Remove break ${i + 1}`}
                  onClick={() =>
                    change({ ...settings, breaks: settings.breaks.filter((_, n) => n !== i) })
                  }
                >
                  Remove break
                </Button>
              </fieldset>
            ))}
            <Button
              type="button"
              variant="outline"
              disabled={settings.breaks.length >= 10}
              onClick={() =>
                change({
                  ...settings,
                  breaks: [
                    ...settings.breaks,
                    { label: 'Break', start_time: '10:00', end_time: '10:20' },
                  ],
                })
              }
            >
              Add break
            </Button>
          </section>
          <div className="rounded-xl bg-lime-50 p-4">
            <p className="mb-3 text-sm">
              After changing the start time, duration, lecture count or breaks, generate lecture
              times. You can then adjust each lecture below.
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                try {
                  change({
                    ...settings,
                    periods: generatePeriods(
                      settings.start_time,
                      settings.lecture_duration,
                      settings.lecture_count,
                      settings.breaks,
                    ).map((p, i) => ({ ...p, label: settings.periods[i]?.label || p.label })),
                  });
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Generate lecture times
            </Button>
          </div>
          <section aria-label="Individual lecture timings" className="space-y-3">
            <h3 className="font-semibold">Individual lecture timings</h3>
            {settings.periods.map((p, i) => (
              <fieldset key={p.number} className="grid gap-2 rounded-xl border p-3 sm:grid-cols-3">
                <legend className="px-1 text-sm">Lecture {p.number}</legend>
                {(['label', 'start_time', 'end_time'] as const).map((k) => (
                  <label className="text-sm" key={k} htmlFor={`period-${p.number}-${k}`}>
                    {k === 'label' ? 'Lecture name' : k === 'start_time' ? 'Starts' : 'Ends'}
                    <input
                      id={`period-${p.number}-${k}`}
                      className="input mt-1"
                      required
                      maxLength={80}
                      type={k === 'label' ? 'text' : 'time'}
                      value={p[k]}
                      onChange={(e) =>
                        change({
                          ...settings,
                          periods: settings.periods.map((v, n) =>
                            n === i ? { ...v, [k]: e.target.value } : v,
                          ),
                        })
                      }
                    />
                  </label>
                ))}
              </fieldset>
            ))}
          </section>
        </fieldset>
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" type="button" onClick={requestClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="lime" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save school timings'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
