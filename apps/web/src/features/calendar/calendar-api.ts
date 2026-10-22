import type { Page } from '@vidyalayaa/contracts';
import { api } from '../../lib/auth';
export async function allCalendarPages<T extends { id: string }>(
  path: string,
  signal: AbortSignal,
) {
  const rows = new Map<string, T>();
  for (let page = 1; ; page++) {
    const data = await api<Page<T>>(
      `${path}${path.includes('?') ? '&' : '?'}page_size=100&page=${page}`,
      { signal },
    );
    for (const row of data.data) rows.set(row.id, row);
    if (page * data.page_size >= data.total || !data.data.length) return [...rows.values()];
  }
}
