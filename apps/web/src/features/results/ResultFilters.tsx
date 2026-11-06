import { useId, type ReactNode } from 'react';

export interface ResultSession {
  id: string;
  name: string;
  is_current: boolean;
}

export interface ResultClass {
  id: string;
  academic_session_id: string;
  academic_session_label: string;
  grade: string;
  section: string;
}

export function ResultFilter({
  label,
  value,
  change,
  children,
  disabled,
  id,
}: {
  label: string;
  value: string;
  change: (value: string) => void;
  children: ReactNode;
  disabled?: boolean;
  id?: string;
}) {
  const generated = useId();
  const field = id || generated;
  return (
    <div className="min-w-0">
      <label className="field-label" htmlFor={field}>
        {label}
      </label>
      <select
        id={field}
        className="input"
        value={value}
        disabled={disabled}
        onChange={(event) => change(event.target.value)}
      >
        {children}
      </select>
    </div>
  );
}
