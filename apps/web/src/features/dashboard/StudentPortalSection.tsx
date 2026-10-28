import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Sparkles,
  BookOpen,
  CalendarCheck2,
  Clock,
  Award,
  CheckCircle2,
  Download,
  CreditCard,
} from 'lucide-react';
import { api, useAuth } from '../../lib/auth';
import { Badge, Loading } from '../../components/common';
import { Button } from '../../components/ui/button';

interface AssignmentItem {
  id: string;
  title: string;
  kind: string;
  due_at?: string;
  body?: string;
  storage_path?: string;
}

interface MarkItem {
  id: string;
  score: number;
  remarks?: string;
  exam_id_label?: string;
  subject_id_label?: string;
}

export default function StudentPortalSection() {
  const a = useAuth();

  const assignmentsQuery = useQuery({
    queryKey: [a.school, 'student-homework'],
    queryFn: () => api<{ data: AssignmentItem[] }>('/resources/assignments?page_size=5'),
    enabled: !!a.school && a.me?.school?.role === 'student',
  });

  const marksQuery = useQuery({
    queryKey: [a.school, 'student-marks'],
    queryFn: () => api<{ data: MarkItem[] }>('/resources/marks?page_size=5'),
    enabled: !!a.school && a.me?.school?.role === 'student',
  });

  if (assignmentsQuery.isLoading && marksQuery.isLoading) return <Loading />;

  const assignments = assignmentsQuery.data?.data || [];
  const marks = marksQuery.data?.data || [];

  return (
    <div className="mb-8 space-y-6">
      <Button asChild variant="outline">
        <Link to="/student/profile">View my profile</Link>
      </Button>
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        {/* Homework & Due Today */}
        <div className="rounded-3xl border border-stone-200 bg-white p-6 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between border-b border-stone-200 pb-3">
              <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-stone-500">
                <BookOpen size={14} className="text-lime-600" /> My Homework & Tasks
              </span>
              <Badge>{assignments.length} Active</Badge>
            </div>

            {assignments.length ? (
              <div className="mt-4 space-y-3">
                {assignments.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-start justify-between rounded-2xl bg-stone-50 p-3 text-xs border border-stone-100"
                  >
                    <div>
                      <span className="inline-block rounded-md bg-lime-100 px-2 py-0.5 text-2xs font-bold text-lime-800 uppercase">
                        {item.kind}
                      </span>
                      <h4 className="mt-1 font-semibold text-stone-900 text-sm">{item.title}</h4>
                      {item.body && (
                        <p className="text-stone-500 line-clamp-1 mt-0.5">{item.body}</p>
                      )}
                    </div>
                    {item.due_at && (
                      <span className="text-right text-xs font-medium text-stone-500 shrink-0">
                        Due{' '}
                        {new Date(item.due_at).toLocaleDateString('en-IN', {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-6 text-center text-xs text-stone-500">
                All caught up! No pending homework assignments.
              </p>
            )}
          </div>

          <div className="mt-4 pt-3 border-t border-stone-100 text-right">
            <Button size="sm" variant="outline" asChild>
              <a href="/r/assignments">View all tasks</a>
            </Button>
          </div>
        </div>

        {/* Latest Results & Scores */}
        <div className="rounded-3xl border border-stone-200 bg-white p-6 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between border-b border-stone-200 pb-3">
              <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-stone-500">
                <Award size={14} className="text-lime-600" /> Recent Results & Marks
              </span>
              <Badge>{marks.length} Graded</Badge>
            </div>

            {marks.length ? (
              <div className="mt-4 space-y-3">
                {marks.map((m) => (
                  <div
                    key={m.id}
                    className="flex items-center justify-between rounded-2xl bg-stone-50 p-3 text-xs border border-stone-100"
                  >
                    <div>
                      <h4 className="font-semibold text-stone-900 text-sm">
                        {m.subject_id_label || 'Subject'}
                      </h4>
                      <p className="text-stone-500 text-xs">
                        {m.exam_id_label || 'Exam'} {m.remarks ? `· ${m.remarks}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 rounded-xl bg-lime-100 px-3 py-1 font-bold text-lime-900 text-sm">
                      {m.score}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-6 text-center text-xs text-stone-500">
                Results appear as teachers publish exam grades.
              </p>
            )}
          </div>

          <div className="mt-4 pt-3 border-t border-stone-100 text-right">
            <Button size="sm" variant="outline" asChild>
              <a href="/r/marks">View full report card</a>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
