import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
export function label(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (x) => x.toUpperCase());
}
export function sexLabel(value: string) {
  return (
    (
      { MALE: 'Male', FEMALE: 'Female', OTHER: 'Other', NOT_SPECIFIED: 'Not specified' } as Record<
        string,
        string
      >
    )[value] || 'Not specified'
  );
}
export function display(value: unknown, timeZone = 'Asia/Kolkata') {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value))
    return new Date(value).toLocaleString('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    });
  return String(value);
}

export { toDateTimeLocal, fromDateTimeLocal } from './date-time';
