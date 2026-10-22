import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { CalendarEvent, Page } from '@vidyalayaa/contracts';
import { calendarKindLabels } from '@vidyalayaa/contracts';
import { CalendarDays, ArrowUpRight } from 'lucide-react';
import { api, useAuth } from '../../lib/auth';
import { schoolPath } from '../../lib/portals';
import { Loading, ErrorState } from '../../components/common';
import { prettyDate, schoolToday, shiftDate, kindColors } from './calendar-utils';

export default function UpcomingEvents() {
  const a = useAuth(),
    from = schoolToday(a.me?.school?.timezone),
    to = shiftDate(from, 30);
  const q = useQuery({
    queryKey: [a.school, 'upcoming-calendar', from],
    queryFn: () => api<Page<CalendarEvent>>(`/calendar/events?from=${from}&to=${to}&page_size=6`),
    enabled: !!a.me?.school?.permissions.includes('calendar.read'),
  });
  return (
    <section
      aria-label="Upcoming school events"
      className="mb-7 rounded-2xl border border-stone-200 bg-white p-5 sm:p-6"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <CalendarDays size={19} /> Upcoming school events
        </h2>
        <Link
          className="inline-flex items-center gap-1 text-sm font-medium underline underline-offset-4"
          to={schoolPath('/calendar', a.me?.school?.role)}
        >
          View calendar <ArrowUpRight size={14} />
        </Link>
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : !q.data?.data.length ? (
        <p className="text-sm text-stone-500">No upcoming events in the next 30 days.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {q.data.data.map((e) => (
            <li key={e.id}>
              <Link
                to={
                  schoolPath('/calendar', a.me?.school?.role) +
                  '?date=' +
                  (e.start_date < from ? from : e.start_date)
                }
                className="block h-full rounded-xl border border-stone-100 bg-stone-50 p-4 transition-colors hover:bg-lime-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-stone-900"
              >
                <span className="text-xs font-semibold" style={{ color: kindColors[e.kind] }}>
                  {calendarKindLabels[e.kind]}
                </span>
                <h3 className="mt-1 break-words text-sm font-semibold">{e.title}</h3>
                <p className="mt-2 text-xs text-stone-500">
                  {prettyDate(e.start_date)}
                  {e.end_date !== e.start_date ? ' – ' + prettyDate(e.end_date) : ''}
                </p>
                <p className="mt-1 text-xs text-stone-600">
                  {e.audience === 'SCHOOL' ? 'Entire school' : 'Your classes and sections'}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
