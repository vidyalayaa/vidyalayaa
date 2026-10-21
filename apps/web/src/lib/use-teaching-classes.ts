import { useQuery } from '@tanstack/react-query';
import type { TeachingClass } from '@vidyalayaa/contracts';
import { api, useAuth } from './auth';

export function useTeachingClasses() {
  const a = useAuth();
  return useQuery({
    queryKey: [a.school, 'teaching-classes'],
    queryFn: () => api<{ data: TeachingClass[] }>('/teaching/classes'),
    enabled: a.me?.school?.role === 'teacher',
    refetchInterval: 30000,
  });
}
