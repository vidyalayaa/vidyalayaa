import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { CalendarDays, ChevronLeft, ChevronRight, Plus, RefreshCw } from 'lucide-react';
import {
  calendarKinds,
  calendarKindLabels,
  type CalendarClass,
  type CalendarEvent,
} from '@vidyalayaa/contracts';
import { api, configured, useAuth } from '../../lib/auth';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { PageHeading, Loading, ErrorState, Empty } from '../../components/common';
import { AttendanceTabs } from '../../components/AttendanceTabs';
import {
  kindColors,
  months,
  calendarDays,
  eventsOn,
  shiftDate,
  prettyDate,
  schoolToday,
  groupClasses,
  audienceLabel,
} from './calendar-utils';
import EventForm from './EventForm';
import { allCalendarPages } from './calendar-api';

function eventBackground(events: CalendarEvent[]) {
  const kinds = [...new Set(events.map((e) => e.kind))];
  if (!kinds.length) return 'var(--surface-muted)';
  if (kinds.length === 1) return kindColors[kinds[0]];
  return `linear-gradient(135deg,${kinds.map((k, i) => `${kindColors[k]} ${(i / kinds.length) * 100}% ${((i + 1) / kinds.length) * 100}%`).join(',')})`;
}
export default function SchoolCalendar({ basePath = '/calendar' }: { basePath?: string }) {
  const a = useAuth(),
    qc = useQueryClient(),
    [params] = useSearchParams();
  const today = schoolToday(a.me?.school?.timezone),
    initial =
      /^(19|20|21|22)\d{2}-\d{2}-\d{2}$/.test(params.get('date') || '') &&
      !isNaN(Date.parse(params.get('date') + 'T12:00:00Z'))
        ? params.get('date')!
        : today;
  const [year, setYear] = useState(Number(initial.slice(0, 4))),
    [month, setMonth] = useState(Number(initial.slice(5, 7)) - 1),
    [mode, setMode] = useState<'year' | 'month'>('year');
  const [kind, setKind] = useState(''),
    [classGroup, setClassGroup] = useState(''),
    [section, setSection] = useState(''),
    [selected, setSelected] = useState(params.has('date') ? initial : ''),
    [focusDate, setFocusDate] = useState(initial);
  const [editing, setEditing] = useState<CalendarEvent | null>(),
    [deleting, setDeleting] = useState<CalendarEvent>(),
    [status, setStatus] = useState('');
  const canManage =
    a.me?.school?.role === 'school_admin' && a.me.school.permissions.includes('calendar.write');
  const allowed = !!a.me?.school?.permissions.includes('calendar.read');
  const classes = useQuery({
    queryKey: [a.school, 'calendar-classes', basePath],
    queryFn: ({ signal }) => allCalendarPages<CalendarClass>(basePath + '/classes', signal),
    enabled: configured && allowed,
  });
  const groups = groupClasses(classes.data || []),
    chosen = groups.find(([key]) => key === classGroup)?.[1] || [],
    filterIds = section ? [section] : chosen.map((c) => c.id);
  const from =
      mode === 'year' ? `${year}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`,
    to =
      mode === 'year'
        ? `${year}-12-31`
        : shiftDate(
            `${year}-${String(month + 2).padStart(2, '0')}-01`.replace(
              `${year}-13-01`,
              `${year + 1}-01-01`,
            ),
            -1,
          );
  const query = new URLSearchParams({
    from,
    to,
    ...(kind ? { kind } : {}),
    ...(filterIds.length ? { class_ids: filterIds.join(',') } : {}),
  });
  const events = useQuery({
    queryKey: [a.school, 'calendar-events', basePath, query.toString()],
    queryFn: ({ signal }) => allCalendarPages<CalendarEvent>(basePath + '/events?' + query, signal),
    enabled: configured && allowed,
  });
  const list = events.data || [],
    days = calendarDays(from, to),
    padding = new Date(from + 'T12:00:00Z').getUTCDay(),
    cells: (string | null)[] = [...Array(padding).fill(null), ...days],
    weeks = Math.ceil(cells.length / 7);
  while (cells.length % 7) cells.push(null);
  const byDate = new Map(days.map((date) => [date, eventsOn(list, date)]));
  const effectiveFocus = focusDate >= from && focusDate <= to ? focusDate : from;
  const remove = useMutation({
    mutationFn: () =>
      api('/calendar/events/' + deleting!.id, {
        method: 'DELETE',
        headers: { 'Idempotency-Key': `calendar-delete-${deleting!.id}-${deleting!.version}` },
        body: JSON.stringify({ expected_version: deleting!.version }),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [a.school] });
      setDeleting(undefined);
      setStatus('Event deleted.');
    },
  });
  const navigate = (direction: number) => {
    if (mode === 'year') setYear((y) => Math.max(1900, Math.min(2200, y + direction)));
    else {
      const date = new Date(Date.UTC(year, month + direction, 1));
      if (date.getUTCFullYear() >= 1900 && date.getUTCFullYear() <= 2200) {
        setYear(date.getUTCFullYear());
        setMonth(date.getUTCMonth());
      }
    }
    setSelected('');
  };
  function day(date: string) {
    const entries = byDate.get(date) || [],
      types = [...new Set(entries.map((e) => e.kind))],
      count = entries.length;
    return (
      <button
        key={date}
        type="button"
        data-date={date}
        tabIndex={date === effectiveFocus ? 0 : -1}
        aria-current={date === today ? 'date' : undefined}
        aria-label={
          mode === 'year'
            ? `${prettyDate(date)} · ${count} ${count === 1 ? 'event' : 'events'}${types.length ? ' · ' + types.map((k) => calendarKindLabels[k]).join(', ') : ''}`
            : undefined
        }
        title={`${prettyDate(date)} · ${count} events`}
        onFocus={() => setFocusDate(date)}
        onClick={() => {
          setSelected(date);
          setStatus('');
        }}
        className={
          mode === 'year'
            ? `h-3.5 w-3.5 rounded-[3px] border border-line outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-stone-900 ${selected === date ? 'ring-2 ring-stone-900' : date === today ? 'ring-2 ring-focus' : ''}`
            : `flex min-h-20 min-w-0 flex-col items-stretch justify-start rounded-lg border p-1 text-left outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-stone-900 sm:min-h-28 sm:p-2 ${selected === date ? 'border-stone-900 bg-lime-50' : 'border-stone-100 bg-surface'}`
        }
        style={
          mode === 'year'
            ? { background: eventBackground(entries), opacity: count === 1 ? 0.78 : 1 }
            : undefined
        }
      >
        {mode === 'month' && (
          <>
            <span
              className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs sm:text-sm ${date === today ? 'bg-lime-300 font-bold' : 'text-stone-700'}`}
            >
              {Number(date.slice(8))}
            </span>
            <span className="mt-1 flex flex-wrap gap-1" aria-hidden="true">
              {types.map((type) => (
                <i
                  key={type}
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: kindColors[type] }}
                />
              ))}
            </span>
            {entries.slice(0, 2).map((e) => (
              <span
                key={e.id}
                className="mt-1 hidden truncate rounded px-1 py-0.5 text-[10px] font-medium sm:block"
                style={{
                  color: kindColors[e.kind],
                  background: `color-mix(in srgb, ${kindColors[e.kind]} 12%, transparent)`,
                }}
              >
                {e.title}
              </span>
            ))}
            {count > 0 && (
              <span className="mt-1 block text-[9px] text-stone-600 sm:text-[10px]">
                {count} {count === 1 ? 'event' : 'events'}
              </span>
            )}
            <span className="sr-only">
              {' · ' + months[month] + ' ' + year}
              {types.length ? ' · ' + types.map((k) => calendarKindLabels[k]).join(', ') : ''}
              {!count ? ' · No events' : ''}
            </span>
          </>
        )}
      </button>
    );
  }
  if (!configured || !allowed)
    return (
      <Empty
        title="Calendar unavailable"
        description="Sign in to your school to see its calendar."
      />
    );
  return (
    <>
      <PageHeading
        title="Your school year, at a glance."
        description={
          canManage
            ? 'Plan school days, celebrations and everything in between.'
            : 'The dates that matter to your school day.'
        }
        actions={
          canManage && (
            <Button
              variant="lime"
              onClick={() => {
                setStatus('');
                setEditing(null);
              }}
            >
              <Plus size={16} /> Add event
            </Button>
          )
        }
      />
      {['school_admin', 'principal', 'teacher'].includes(a.me?.school?.role || '') && (
        <AttendanceTabs active="calendar" />
      )}
      {status && (
        <p role="status" className="mb-4 rounded-xl bg-lime-50 p-3 text-sm">
          {status}
        </p>
      )}
      <section
        aria-label="School calendar"
        className="min-w-0 rounded-2xl border border-stone-200 bg-surface p-4 sm:p-6"
      >
        <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              aria-label={`Previous ${mode}`}
              onClick={() => navigate(-1)}
              disabled={year === 1900 && (mode === 'year' || month === 0)}
            >
              <ChevronLeft size={16} />
            </Button>
            <label className="sr-only" htmlFor="calendar-year">
              Calendar year
            </label>
            <select
              id="calendar-year"
              className="input !w-24"
              value={year}
              onChange={(e) => {
                setYear(Number(e.target.value));
                setSelected('');
              }}
            >
              {Array.from({ length: 301 }, (_, n) => 1900 + n).map((y) => (
                <option key={y}>{y}</option>
              ))}
            </select>
            {mode === 'month' && (
              <>
                <label className="sr-only" htmlFor="calendar-month">
                  Calendar month
                </label>
                <select
                  id="calendar-month"
                  className="input !w-32"
                  value={month}
                  onChange={(e) => {
                    setMonth(Number(e.target.value));
                    setSelected('');
                  }}
                >
                  {months.map((m, i) => (
                    <option key={m} value={i}>
                      {m}
                    </option>
                  ))}
                </select>
              </>
            )}
            <Button
              size="sm"
              variant="outline"
              aria-label={`Next ${mode}`}
              onClick={() => navigate(1)}
              disabled={year === 2200 && (mode === 'year' || month === 11)}
            >
              <ChevronRight size={16} />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setYear(Number(today.slice(0, 4)));
                setMonth(Number(today.slice(5, 7)) - 1);
                setFocusDate(today);
              }}
            >
              Today
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant={mode === 'year' ? 'lime' : 'outline'}
              aria-pressed={mode === 'year'}
              onClick={() => setMode('year')}
            >
              Year view
            </Button>
            <Button
              size="sm"
              variant={mode === 'month' ? 'lime' : 'outline'}
              aria-pressed={mode === 'month'}
              onClick={() => setMode('month')}
            >
              Month view
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Refresh calendar"
              disabled={events.isFetching}
              onClick={() => events.refetch()}
            >
              <RefreshCw size={15} />
            </Button>
          </div>
        </div>
        <div className="mb-6 grid gap-3 sm:grid-cols-3">
          <label className="text-sm" htmlFor="calendar-type">
            Event type
            <select
              id="calendar-type"
              className="input mt-2"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="">All event types</option>
              {calendarKinds.map((k) => (
                <option key={k} value={k}>
                  {calendarKindLabels[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm" htmlFor="calendar-class">
            Class
            <select
              id="calendar-class"
              className="input mt-2"
              value={classGroup}
              onChange={(e) => {
                setClassGroup(e.target.value);
                setSection('');
              }}
            >
              <option value="">All relevant classes</option>
              {groups.map(([key, rows]) => (
                <option key={key} value={key}>
                  Class {rows[0].grade} · {rows[0].session_name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm" htmlFor="calendar-section">
            Section
            <select
              id="calendar-section"
              className="input mt-2"
              disabled={!classGroup}
              value={section}
              onChange={(e) => setSection(e.target.value)}
            >
              <option value="">All sections</option>
              {chosen.map((c) => (
                <option key={c.id} value={c.id}>
                  Section {c.section}
                </option>
              ))}
            </select>
          </label>
        </div>
        {classes.error && <ErrorState error={classes.error} retry={() => classes.refetch()} />}
        {events.isLoading ? (
          <Loading />
        ) : events.error ? (
          <ErrorState error={events.error} retry={() => events.refetch()} />
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                <CalendarDays size={20} />
                {mode === 'year' ? year : `${months[month]} ${year}`}
              </h2>
              <p className="text-sm text-stone-500">
                {list.length} {list.length === 1 ? 'event' : 'events'} · Select a date for details
              </p>
            </div>
            <div
              className="max-w-full overflow-x-auto pb-3"
              onKeyDown={(e) => {
                const current = (e.target as HTMLElement).dataset.date;
                if (!current) return;
                const delta =
                  mode === 'year'
                    ? { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }
                    : { ArrowUp: -7, ArrowDown: 7, ArrowLeft: -1, ArrowRight: 1 };
                if (!(e.key in delta)) return;
                e.preventDefault();
                const next = shiftDate(current, delta[e.key as keyof typeof delta]);
                if (next >= from && next <= to)
                  e.currentTarget
                    .querySelector<HTMLButtonElement>(`[data-date="${next}"]`)
                    ?.focus();
              }}
            >
              {mode === 'year' ? (
                <div className="w-max" role="group" aria-label={`${year} year calendar`}>
                  <div
                    className="mb-2 ml-8 grid text-[11px] text-stone-500"
                    style={{ gridTemplateColumns: `repeat(${weeks},14px)`, gap: 4 }}
                  >
                    {months.map((m, i) => {
                      const first = `${year}-${String(i + 1).padStart(2, '0')}-01`,
                        offset = Math.round((Date.parse(first) - Date.parse(from)) / 86400000);
                      return (
                        <span
                          key={m}
                          style={{
                            gridColumn: `${Math.floor((padding + offset) / 7) + 1} / span 3`,
                          }}
                        >
                          {m.slice(0, 3)}
                        </span>
                      );
                    })}
                  </div>
                  <div className="flex gap-2">
                    <div
                      className="grid w-6 text-[10px] leading-[14px] text-stone-500"
                      style={{ gridTemplateRows: 'repeat(7,14px)', gap: 4 }}
                      aria-hidden="true"
                    >
                      {['', 'Mon', '', 'Wed', '', 'Fri', ''].map((d, i) => (
                        <span key={i}>{d}</span>
                      ))}
                    </div>
                    <div
                      className="grid grid-flow-col gap-1"
                      style={{
                        gridTemplateRows: 'repeat(7,14px)',
                        gridTemplateColumns: `repeat(${weeks},14px)`,
                      }}
                    >
                      {cells.map((date, i) =>
                        date ? day(date) : <span key={`blank-${i}`} aria-hidden="true" />,
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div role="group" aria-label={`${months[month]} ${year} month calendar`}>
                  <div
                    className="mb-2 grid grid-cols-7 gap-1 text-center text-xs text-stone-500"
                    aria-hidden="true"
                  >
                    {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
                      <span key={d}>{d}</span>
                    ))}
                  </div>
                  <div className="grid grid-cols-7 gap-1 sm:gap-2">
                    {cells.map((date, i) =>
                      date ? day(date) : <span key={`blank-${i}`} aria-hidden="true" />,
                    )}
                  </div>
                </div>
              )}
            </div>
            <p className="mt-2 text-xs text-stone-500">
              Use arrow keys to move between dates. Multi-day events appear on every included date.
            </p>
            <ul
              aria-label="Event type legend"
              className="mt-4 flex flex-wrap gap-x-4 gap-y-2 border-t border-stone-100 pt-4 text-xs text-stone-600"
            >
              {calendarKinds.map((k) => (
                <li key={k} className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: kindColors[k] }} />
                  {calendarKindLabels[k]}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      {selected && (
        <Dialog
          open
          title={`Events on ${prettyDate(selected)}`}
          description="School events scheduled for this date."
          onOpenChange={(v) => {
            if (!v) setSelected('');
          }}
        >
          {events.isFetching && !events.data ? (
            <Loading />
          ) : events.error ? (
            <ErrorState error={events.error} retry={() => events.refetch()} />
          ) : (
            <div className="space-y-4">
              {!eventsOn(list, selected).length && (
                <p className="rounded-xl bg-stone-50 p-4 text-sm text-stone-500">
                  No events on this date match the current filters.
                </p>
              )}
              {eventsOn(list, selected).map((e) => (
                <article
                  key={e.id}
                  className="rounded-xl border border-stone-200 p-4"
                  aria-label={`Calendar event ${e.title}`}
                >
                  <p className="mb-2 text-xs font-semibold" style={{ color: kindColors[e.kind] }}>
                    {calendarKindLabels[e.kind]}
                  </p>
                  <h3 className="font-semibold">{e.title}</h3>
                  {e.description && (
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm text-stone-600">
                      {e.description}
                    </p>
                  )}
                  <p className="mt-3 text-xs text-stone-500">
                    {prettyDate(e.start_date)}
                    {e.end_date !== e.start_date ? ' – ' + prettyDate(e.end_date) : ''}
                  </p>
                  <p className="mt-1 text-xs text-stone-600">{audienceLabel(e)}</p>
                  {canManage && (
                    <div className="mt-4 flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Edit event ${e.title}`}
                        onClick={() => setEditing(e)}
                      >
                        Edit event
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Delete event ${e.title}`}
                        onClick={() => {
                          remove.reset();
                          setDeleting(e);
                        }}
                      >
                        Delete event
                      </Button>
                    </div>
                  )}
                </article>
              ))}
              {canManage && (
                <Button variant="lime" onClick={() => setEditing(null)}>
                  <Plus size={16} /> Add event on this date
                </Button>
              )}
            </div>
          )}
        </Dialog>
      )}
      {editing !== undefined && (
        <EventForm
          key={editing?.id || selected || from}
          event={editing || undefined}
          date={selected || (today >= from && today <= to ? today : from)}
          classes={classes.data || []}
          close={() => setEditing(undefined)}
          saved={() => {
            setEditing(undefined);
            setStatus('Event saved.');
          }}
        />
      )}
      {deleting && (
        <Dialog
          open
          title="Delete calendar event"
          description={`Remove “${deleting.title}” from school calendars?`}
          onOpenChange={(v) => {
            if (!v && !remove.isPending) setDeleting(undefined);
          }}
        >
          <p className="text-sm text-stone-600">The event will no longer appear on the calendar.</p>
          {remove.error && (
            <p role="alert" className="field-error mt-3">
              {remove.error.message}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-3">
            <Button
              variant="outline"
              disabled={remove.isPending}
              onClick={() => setDeleting(undefined)}
            >
              Cancel
            </Button>
            <Button variant="lime" disabled={remove.isPending} onClick={() => remove.mutate()}>
              {remove.isPending ? 'Deleting…' : 'Delete event'}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
