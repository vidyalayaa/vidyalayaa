import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Page } from '@vidyalayaa/contracts';
import { api, configured, useAuth } from './auth';
export function useRows(endpoint: string) {
  const a = useAuth(),
    [page, setPage] = useState(1),
    [cursors, setCursors] = useState<Record<number, string>>({ 1: '' }),
    cursor = endpoint === '/notifications' || endpoint === '/audit',
    automatic = !/[?&]page=/.test(endpoint);
  useEffect(() => {
    setPage(1);
    setCursors({ 1: '' });
  }, [endpoint, a.school]);
  const path = automatic
    ? `${endpoint}${endpoint.includes('?') ? '&' : '?'}page=${page}${cursor ? `&cursor=1${cursors[page] ? `&after=${encodeURIComponent(cursors[page])}` : ''}` : ''}`
    : endpoint;
  const query = useQuery({
    queryKey: [a.school, endpoint, page, cursor ? cursors[page] : ''],
    queryFn: () => api<Page>(path),
    enabled: configured && !!a.me?.school,
    refetchInterval: endpoint === '/reports' ? 10000 : 30000,
  });
  return {
    ...query,
    page,
    setPage: (n: number) => {
      if (cursor && n > page) {
        if (!query.data?.next_cursor) return;
        setCursors((values) => ({ ...values, [n]: query.data!.next_cursor! }));
      }
      setPage(n);
    },
    automatic,
    hasNext: cursor ? !!query.data?.next_cursor : undefined,
  };
}
