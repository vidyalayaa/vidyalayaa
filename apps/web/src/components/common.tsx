import { ArrowUpRight, Inbox, Loader2, RefreshCw, ShieldCheck, AlertCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './ui/button';
import { display, label, cn } from '../lib/utils';
import { HttpError } from '../lib/auth';
import { useAuth } from '../lib/auth';
export function Badge({ children }: { children: ReactNode }) {
  const value = String(children);
  return (
    <span
      className={cn(
        'badge',
        /ACTIVE|PRESENT|SENT|COMPLETED|PAID|ON_TIME|APPLIED|ONLINE/.test(value)
          ? 'badge-green'
          : /ABSENT|DEAD|FAIL|REVOKED|BLOCKED|OFFLINE/.test(value)
            ? 'badge-red'
            : /LATE|PARTIAL|PENDING|PAST_DUE|REQUESTED/.test(value)
              ? 'badge-amber'
              : 'badge-neutral',
      )}
    >
      {label(value)}
    </span>
  );
}
export function Empty({
  title = 'A fresh start',
  description = 'Records will appear here when your school adds them.',
  action,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Inbox size={25} strokeWidth={1.5} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Loading() {
  return (
    <div className="p-6" role="status" aria-label="Loading records">
      <span className="sr-only">Getting everything ready…</span>
      <div aria-hidden="true" className="space-y-3 animate-pulse">
        <div className="h-5 w-1/3 rounded bg-stone-100" />
        <div className="h-12 rounded bg-stone-100" />
        <div className="h-12 rounded bg-stone-100" />
      </div>
    </div>
  );
}
export function ErrorState({ error, retry }: { error: Error; retry?: () => void }) {
  return (
    <div className="error-state" role="alert">
      <AlertCircle size={22} />
      <div>
        <h3>We couldn’t complete that request</h3>
        <p>{error.message}</p>
        {error instanceof HttpError && error.requestId && (
          <p className="mt-1 text-xs">Reference: {error.requestId}</p>
        )}
        {retry && (
          <Button className="mt-3" size="sm" variant="outline" onClick={retry}>
            <RefreshCw size={14} />
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}
export function PageHeading({
  eyebrow = 'YOUR SCHOOL, IN SYNC',
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      <div className="heading-actions">{actions}</div>
    </div>
  );
}
export function Panel({
  title,
  subtitle,
  action,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('panel', className)}>
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
export function DataTable({
  rows,
  columns,
  onEdit,
  onView,
  actions,
}: {
  rows: Record<string, unknown>[];
  columns: string[];
  onEdit?: (row: Record<string, unknown>) => void;
  onView?: (row: Record<string, unknown>) => void;
  actions?: (row: Record<string, unknown>) => ReactNode;
}) {
  const timeZone = useAuth().me?.school?.timezone;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col">
                {label(c.replace(/_id$/, ''))}
              </th>
            ))}
            {(onEdit || onView || actions) && (
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={String(row.id || i)}>
              {columns.map((c) => (
                <td key={c} data-label={label(c.replace(/_id$/, ''))}>
                  {[
                    'status',
                    'attendance_status',
                    'movement_status',
                    'channel',
                    'kind',
                    'role',
                  ].includes(c) ? (
                    <Badge>{display(row[c])}</Badge>
                  ) : c.endsWith('_id') ? (
                    <span className="text-xs text-stone-500" title={String(row[c] || '')}>
                      {row[c.replace(/_id$/, '_label')]
                        ? display(row[c.replace(/_id$/, '_label')])
                        : display(row[c]).slice(0, 12)}
                    </span>
                  ) : (
                    display(row[c], timeZone)
                  )}
                </td>
              ))}
              {(onEdit || onView || actions) && (
                <td>
                  <div className="flex items-center justify-end gap-2">
                    {actions?.(row)}
                    {onView && (
                      <Button variant="outline" size="sm" onClick={() => onView(row)}>
                        View
                      </Button>
                    )}
                    {onEdit && (
                      <button
                        className="row-action"
                        onClick={() => onEdit(row)}
                        aria-label={`Edit ${String(row.first_name || row.name || row.title || 'record')}`}
                      >
                        <ArrowUpRight size={17} />
                      </button>
                    )}
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function SecureNote() {
  return (
    <p className="secure-note">
      <ShieldCheck size={14} />
      Protected by school access controls
    </p>
  );
}
