import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Page } from '@vidyalayaa/contracts';
import { api, configured, useAuth } from '../lib/auth';

export function recordLabel(row: Record<string, unknown>) {
  const name =
    row.full_name ||
    row.name ||
    row.title ||
    [row.first_name || row.grade, row.last_name || row.section].filter(Boolean).join(' ');
  const code = row.student_code || row.staff_code || row.code || row.email;
  return `${name || 'Record'}${code ? ' · ' + String(code) : ''}`;
}
export default function RecordSelect({
  name,
  id = name,
  endpoint,
  value,
  defaultValue = '',
  onChange,
  optional = false,
  label = 'record',
  disabled = false,
}: {
  name: string;
  id?: string;
  endpoint: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  optional?: boolean;
  label?: string;
  disabled?: boolean;
}) {
  const a = useAuth();
  const [selected, setSelected] = useState(defaultValue);
  const [search, setSearch] = useState(''),
    [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const query = useQuery({
    queryKey: [a.school, 'lookup', endpoint, debounced],
    queryFn: () =>
      api<Page>(
        `${endpoint}${endpoint.includes('?') ? '&' : '?'}page_size=100&search=${encodeURIComponent(debounced)}`,
      ),
    enabled:
      configured &&
      (!!a.me?.school ||
        (endpoint === '/platform/schools' && a.me?.platform_role === 'SUPER_ADMIN')),
  });
  const current = value ?? selected;
  return (
    <div>
      <input
        className="input mb-2 h-10"
        aria-label={`Find ${label}`}
        placeholder="Find by name or code…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        disabled={disabled}
      />
      <select
        id={id}
        name={name}
        className="input"
        value={current}
        required={!optional}
        disabled={disabled || query.isLoading}
        onChange={(event) => {
          setSelected(event.target.value);
          onChange?.(event.target.value);
        }}
      >
        <option value="">
          {query.isLoading
            ? 'Loading records…'
            : optional
              ? 'None / all permitted records'
              : 'Select a record'}
        </option>
        {query.data?.data.map((row) => (
          <option key={String(row.id)} value={String(row.id)}>
            {recordLabel(row)}
          </option>
        ))}
        {current && !query.data?.data.some((row) => row.id === current) && (
          <option value={current}>Previously selected record</option>
        )}
      </select>
      {query.data && query.data.total > 100 && (
        <p className="mt-1 text-xs text-stone-600">
          Showing 100 matches. Search to find another record.
        </p>
      )}
      {query.error && (
        <p className="field-error" role="alert">
          {query.error.message}
        </p>
      )}
    </div>
  );
}
