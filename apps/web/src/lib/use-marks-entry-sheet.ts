import { useQuery } from '@tanstack/react-query';
import type { MarksEntrySheet } from '@vidyalayaa/contracts';
import { api, useAuth } from './auth';
export function useMarksEntrySheet(examId: string) {
  const a = useAuth();
  return useQuery({
    queryKey: [a.school, 'marks-entry-sheet', examId],
    queryFn: ({ signal }) =>
      api<MarksEntrySheet>(`/marks/entry-sheet?exam_id=${examId}`, { signal }),
    enabled: !!examId,
    staleTime: 0,
  });
}
