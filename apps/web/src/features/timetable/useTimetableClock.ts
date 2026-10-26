import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TimetableClock } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { localSchoolTime } from './timetable-utils';

// Anchor to the API clock, then advance monotonically. Browser timezone and
// changes to the device wall clock cannot move the school's lecture indicator.
export function useTimetableClock(basePath: string, enabled: boolean) {
  const a = useAuth(),
    [tick, setTick] = useState(0);
  const query = useQuery({
    queryKey: [a.school, 'timetable-clock', basePath],
    queryFn: async ({ signal }) => {
      const before = performance.now(),
        clock = await api<TimetableClock>(basePath + '/clock', { signal }),
        after = performance.now();
      const stamp = Date.parse(clock.server_time);
      if (!Number.isFinite(stamp) || typeof clock.timezone !== 'string' || !clock.timezone)
        throw new Error('The school clock is unavailable.');
      localSchoolTime(new Date(stamp), clock.timezone);
      return { stamp: stamp + (after - before) / 2, received: after, timezone: clock.timezone };
    },
    enabled,
    staleTime: 30000,
    refetchInterval: 60000,
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    if (!enabled) return;
    const update = () => setTick((n) => n + 1),
      wake = () => {
        update();
        if (document.visibilityState === 'visible') void query.refetch();
      },
      id = window.setInterval(update, 250);
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [enabled, query.refetch]);
  const sample = query.data;
  void tick;
  return {
    time: sample
      ? localSchoolTime(
          new Date(sample.stamp + performance.now() - sample.received),
          sample.timezone,
        )
      : null,
    timezone: sample?.timezone || a.me?.school?.timezone,
    error: query.error,
    retry: query.refetch,
  };
}
