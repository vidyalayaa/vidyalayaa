import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BookOpen,
  CalendarCheck2,
  Users,
  Clock,
  Sparkles,
  ArrowRight,
  ClipboardList,
} from 'lucide-react';
import { api, useAuth } from '../../lib/auth';
import { Button } from '../../components/ui/button';
import { Badge, Loading } from '../../components/common';
import ClassAttendanceSheet from '../operations/ClassAttendanceSheet';
import { useTeachingClasses } from '../../lib/use-teaching-classes';

interface ClassItem {
  id: string;
  grade: string;
  section: string;
}

interface TimetableItem {
  id: string;
  class_id: string;
  subject_id: string;
  starts_at: string;
  ends_at: string;
  room?: string;
  subject_name?: string;
  class_grade?: string;
  class_section?: string;
}

export default function TeacherPortalSection() {
  const a = useAuth();
  const [rollCallClassId, setRollCallClassId] = useState<string | null>(null);

  // Fetch teacher's assigned classes
  const classesQuery = useTeachingClasses();

  const classes = classesQuery.data?.data || [];

  if (classesQuery.isLoading) return <Loading />;
  if (!classes.length) return null;

  return (
    <div className="mb-8 rounded-3xl border border-stone-200 bg-surface p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-stone-200 pb-5">
        <div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-lime-100 px-3 py-1 text-xs font-semibold text-lime-800">
            <Sparkles size={12} /> TEACHER COCKPIT
          </span>
          <h2 className="mt-2 text-xl font-bold tracking-tight text-stone-900">
            Your Classroom Command
          </h2>
          <p className="text-xs text-stone-600">
            One-tap attendance roll calls and classroom tools.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <a href="/r/assignments">
              <BookOpen size={15} />
              Post Homework
            </a>
          </Button>
          <Button variant="outline" asChild>
            <a href="/subject-tests">
              <ClipboardList size={15} />
              Subject tests & marks
            </a>
          </Button>
          <Button variant="outline" asChild>
            <a href="/academic-intelligence">Academic Performance &amp; AI Analysis</a>
          </Button>
          {classes.some((c) => c.is_class_teacher) && (
            <Button variant="outline" asChild>
              <a href="/official-results">Official exam results</a>
            </Button>
          )}
        </div>
      </div>

      <div className="mt-6">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-stone-500 mb-3">
          Assigned Classes · 1-Click Roll Call
        </h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {classes.map((cls) => (
            <div
              key={cls.id}
              className="group flex flex-col justify-between rounded-2xl border border-stone-200 bg-stone-50 p-4 transition-all hover:border-lime-300 hover:bg-lime-50/30"
            >
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold text-stone-900">
                    Grade {cls.grade} - Section {cls.section || 'A'}
                  </span>
                  <span className="flex size-8 items-center justify-center rounded-xl bg-surface text-stone-700 shadow-xs border border-stone-200 text-xs font-semibold">
                    {cls.grade}
                    {cls.section || 'A'}
                  </span>
                </div>
                <p className="mt-1 text-xs text-stone-500">
                  Full classroom register and student roster
                </p>
              </div>

              <div className="mt-4 pt-3 border-t border-stone-200/60 flex items-center justify-between">
                <Button
                  size="sm"
                  variant="lime"
                  className="w-full text-xs font-semibold"
                  disabled={!cls.is_class_teacher}
                  onClick={() => setRollCallClassId(cls.id)}
                >
                  <CalendarCheck2 size={14} />
                  {cls.is_class_teacher ? 'Take Class Roll Call' : 'Attendance is view only'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {rollCallClassId && (
        <ClassAttendanceSheet
          open={!!rollCallClassId}
          close={() => setRollCallClassId(null)}
          initialClassId={rollCallClassId}
        />
      )}
    </div>
  );
}
