import type { Page } from '@vidyalayaa/contracts';
import { api } from '../../lib/auth';
export async function timetablePages<T extends { id: string }>(path: string, signal: AbortSignal) {
  const rows = new Map<string, T>();
  let received = 0;
  for (let page = 1; ; page++) {
    const r = await api<Page<T>>(
      `${path}${path.includes('?') ? '&' : '?'}page_size=100&page=${page}`,
      { signal },
    );
    received += r.data.length;
    for (const row of r.data) rows.set(row.id, row);
    if (!r.data.length || received >= r.total) return [...rows.values()];
  }
}
