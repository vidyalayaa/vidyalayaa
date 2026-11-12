import { useState, type ReactNode } from 'react';
import { parentDateRangeSchema } from '@vidyalayaa/contracts';
import { Button } from '../../components/ui/button';
export function Metric({
  title,
  value,
  detail,
}: {
  title: string;
  value: string | number;
  detail: string;
}) {
  return (
    <article className="min-w-0 rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <p className="text-xs font-medium text-stone-600">{title}</p>
      <p className="mt-2 break-words text-2xl font-bold text-stone-900">{value}</p>
      <p className="mt-2 text-xs text-stone-500">{detail}</p>
    </article>
  );
}
export function DateFilters({
  range,
  today,
  academicStart,
  onApply,
  children,
}: {
  range: { from: string; to: string };
  today: string;
  academicStart?: string;
  onApply: (dates: { from: string; to: string }) => void;
  children?: ReactNode;
}) {
  const [from, setFrom] = useState(range.from),
    [to, setTo] = useState(range.to),
    [error, setError] = useState('');
  function apply(dates: { from: string; to: string }) {
    const valid = parentDateRangeSchema.safeParse(dates);
    if (!valid.success || dates.from > today || dates.to > today) {
      setError('Choose valid dates on or before today, covering at most 366 days.');
      return;
    }
    setError('');
    setFrom(dates.from);
    setTo(dates.to);
    onApply(dates);
  }
  const lastStart = new Date(today.slice(0, 7) + '-01T12:00:00Z');
  lastStart.setUTCMonth(lastStart.getUTCMonth() - 1);
  const lastEnd = new Date(today.slice(0, 7) + '-01T12:00:00Z');
  lastEnd.setUTCDate(0);
  const earliest = new Date(Date.parse(today + 'T12:00:00Z') - 365 * 86400000)
    .toISOString()
    .slice(0, 10);
  return (
    <section
      className="mb-5 rounded-2xl border border-line bg-surface p-4 sm:p-5"
      aria-label="Date and record filters"
    >
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          apply({ from, to });
        }}
      >
        <label className="text-sm">
          From
          <input
            className="input mt-1"
            aria-label="From date"
            type="date"
            max={today}
            value={from}
            required
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="text-sm">
          To
          <input
            className="input mt-1"
            aria-label="To date"
            type="date"
            max={today}
            value={to}
            required
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        {children}
        <Button type="submit" variant="lime">
          Apply filters
        </Button>
      </form>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => apply({ from: today.slice(0, 7) + '-01', to: today })}
        >
          This month
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            apply({
              from: lastStart.toISOString().slice(0, 10),
              to: lastEnd.toISOString().slice(0, 10),
            })
          }
        >
          Last month
        </Button>
        {academicStart && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              apply({ from: academicStart < earliest ? earliest : academicStart, to: today })
            }
          >
            Academic year
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="field-error mt-3">
          {error}
        </p>
      )}
    </section>
  );
}
