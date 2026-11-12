import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Users,
  CheckCheck,
  Clock3,
  Calendar,
  CreditCard,
  Wallet,
  Award,
  ArrowRight,
  ShieldCheck,
  Sparkles,
  ExternalLink,
} from 'lucide-react';
import { api, useAuth } from '../../lib/auth';
import { Button } from '../../components/ui/button';
import { Badge, Loading } from '../../components/common';
import StudentProfileDialog from '../resources/StudentProfileDialog';
import { Link } from 'react-router-dom';
import { schoolPath } from '../../lib/portals';
import { PersonAvatar } from '../profiles/PersonAvatar';

interface ChildSummary {
  id: string;
  student_code: string;
  first_name: string;
  last_name: string;
  date_of_birth: string;
}

interface FamilyData {
  profile: { id: string; full_name: string; email: string; phone: string } | null;
  children: ChildSummary[];
}

interface StudentOverview {
  student: {
    id: string;
    student_code: string;
    first_name: string;
    last_name: string;
    status: string;
    gender?: string;
    profile_photo_id?: string | null;
  };
  enrollment?: {
    grade?: string;
    section?: string;
    session_name?: string;
  };
  card?: {
    card_uid: string;
    status: string;
  };
  attendance: {
    today?: {
      attendance_status: string;
      movement_status: string;
      first_arrival_at?: string;
      last_departure_at?: string;
    };
    summary: {
      total: number;
      present: number;
      late: number;
      absent: number;
      percentage: number;
    };
  };
  fees: {
    summary: {
      total_due: number;
      total_paid: number;
      balance: number;
      unpaid_count: number;
    };
    records: Array<{
      id: string;
      fee_type: string;
      amount_due: number;
      amount_paid: number;
      due_on: string;
      status: string;
      currency?: string;
    }>;
  };
  marks: Array<{
    id: string;
    score: number;
    exam_name: string;
    max_score: number;
    subject_name: string;
    remarks?: string;
  }>;
}

export default function ParentPortalSection() {
  const a = useAuth();
  const [selectedChildId, setSelectedChildId] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);

  const familyQuery = useQuery({
    queryKey: [a.school, 'parent-family'],
    queryFn: () => api<FamilyData>('/profile/family'),
    enabled: !!a.school && a.me?.school?.role === 'parent',
  });

  const children = familyQuery.data?.children || [];
  const activeChildId = selectedChildId || children[0]?.id || null;

  const overviewQuery = useQuery({
    queryKey: [a.school, 'student-overview', activeChildId],
    queryFn: () => api<StudentOverview>(`/students/${activeChildId}/overview`),
    enabled: !!activeChildId,
  });

  if (familyQuery.isLoading) return <Loading />;
  if (!children.length) return null;

  const o = overviewQuery.data;

  return (
    <div className="mb-8 space-y-6">
      {/* Child Selector Switcher */}
      {children.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-stone-100/80 p-2 border border-stone-200">
          <span className="px-3 text-xs font-semibold text-stone-500 uppercase tracking-wider">
            Switch Child:
          </span>
          {children.map((child) => {
            const isSelected = activeChildId === child.id;
            return (
              <button
                key={child.id}
                type="button"
                onClick={() => setSelectedChildId(child.id)}
                className={`flex items-center gap-2.5 rounded-xl px-4 py-2 text-sm font-medium transition-all ${
                  isSelected
                    ? 'bg-surface text-stone-900 shadow-sm border border-stone-300 ring-2 ring-lime-500/20'
                    : 'text-stone-600 hover:bg-stone-200/60 hover:text-stone-900'
                }`}
              >
                <span className="flex size-7 items-center justify-center rounded-full bg-lime-100 text-lime-800 text-xs font-bold">
                  {child.first_name[0]}
                </span>
                <span>
                  {child.first_name} {child.last_name}
                </span>
                <span className="text-xs text-stone-400 font-mono">({child.student_code})</span>
              </button>
            );
          })}
        </div>
      )}

      {overviewQuery.isLoading ? (
        <Loading />
      ) : o ? (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {/* Digital Campus ID Card */}
          <div className="relative overflow-hidden rounded-3xl border border-stone-200 bg-gradient-to-br from-inverse to-inverse-raised p-6 text-inverse-ink shadow-xl flex flex-col justify-between min-h-64">
            <div className="relative z-10 flex items-start justify-between">
              <div>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/20 px-2.5 py-0.5 text-xs font-semibold text-accent border border-accent/30">
                  <Sparkles size={11} /> DIGITAL STUDENT PASS
                </span>
                <h3 className="mt-3 flex items-center gap-2 text-xl font-bold tracking-tight text-inverse-ink">
                  <PersonAvatar
                    kind="student"
                    id={o.student.id}
                    photo={o.student.profile_photo_id}
                    name={`${o.student.first_name} ${o.student.last_name || ''}`}
                    decorative
                  />
                  <span>
                    {o.student.first_name} {o.student.last_name}
                  </span>
                </h3>
                <p className="text-xs text-inverse-muted font-mono mt-0.5">
                  ID: {o.student.student_code} ·{' '}
                  {o.enrollment?.grade
                    ? `Class ${o.enrollment.grade} ${o.enrollment.section || ''}`
                    : 'Enrolled'}
                </p>
              </div>
              <span className="flex size-12 items-center justify-center rounded-2xl bg-inverse-ink/10 text-inverse-ink font-bold text-lg border border-inverse-ink/10">
                {o.student.first_name[0]}
                {o.student.last_name?.[0]}
              </span>
            </div>

            <div className="relative z-10 my-4 space-y-2 rounded-2xl bg-inverse-ink/5 p-4 border border-inverse-ink/10 text-xs">
              <div className="flex justify-between items-center">
                <span className="text-inverse-muted">Campus Status</span>
                <Badge>
                  {o.attendance.today?.movement_status === 'ON_CAMPUS'
                    ? '🟢 ON CAMPUS'
                    : o.attendance.today?.attendance_status || 'NOT LOGGED'}
                </Badge>
              </div>
              {o.attendance.today?.first_arrival_at && (
                <div className="flex justify-between items-center text-inverse-muted">
                  <span className="text-inverse-muted">Arrived at</span>
                  <span className="font-semibold text-inverse-ink">
                    {new Date(o.attendance.today.first_arrival_at).toLocaleTimeString('en-IN', {
                      hour: '2-digit',
                      minute: '2-digit',
                      timeZone: a.me?.school?.timezone,
                    })}
                  </span>
                </div>
              )}
              <div className="flex justify-between items-center text-inverse-muted">
                <span className="text-inverse-muted">Smart NFC Card</span>
                <span className="font-mono text-accent font-semibold">
                  {o.card?.card_uid ? `●●●● ${o.card.card_uid.slice(-4)}` : 'Card not linked'}
                </span>
              </div>
            </div>

            <div className="relative z-10 flex items-center justify-between pt-2 border-t border-inverse-ink/10">
              <span className="text-xs text-inverse-muted font-mono">
                {a.me?.school?.school_name}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="bg-inverse-ink/10 text-inverse-ink hover:bg-inverse-ink/20 border-inverse-ink/20 text-xs"
                onClick={() => setProfileOpen(true)}
              >
                Full Profile <ExternalLink size={13} className="ml-1" />
              </Button>
            </div>
          </div>

          {/* 30-Day Attendance Card */}
          <div className="rounded-3xl border border-stone-200 bg-surface p-6 shadow-sm flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-stone-500 uppercase tracking-wider">
                  30-Day Attendance
                </span>
                <Badge>{o.attendance.summary.percentage}% Present</Badge>
              </div>

              <div className="mt-4 flex items-baseline gap-2">
                <span className="text-4xl font-extrabold text-stone-900 tracking-tight">
                  {o.attendance.summary.percentage}%
                </span>
                <span className="text-xs text-stone-500">attendance consistency</span>
              </div>

              {/* Progress bar */}
              <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-stone-100">
                <div
                  className="h-full bg-lime-500 transition-all duration-500 rounded-full"
                  style={{ width: `${Math.min(100, o.attendance.summary.percentage)}%` }}
                />
              </div>

              <div className="mt-5 grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded-xl bg-green-50 p-2.5 border border-green-200">
                  <p className="font-bold text-green-800 text-base">
                    {o.attendance.summary.present}
                  </p>
                  <p className="text-green-700 text-xs mt-0.5">Present</p>
                </div>
                <div className="rounded-xl bg-amber-50 p-2.5 border border-amber-100">
                  <p className="font-bold text-amber-800 text-base">{o.attendance.summary.late}</p>
                  <p className="text-amber-700 text-xs mt-0.5">Late</p>
                </div>
                <div className="rounded-xl bg-rose-50 p-2.5 border border-rose-100">
                  <p className="font-bold text-rose-800 text-base">{o.attendance.summary.absent}</p>
                  <p className="text-rose-700 text-xs mt-0.5">Absent</p>
                </div>
              </div>
            </div>

            <p className="mt-4 text-xs text-stone-500 text-center">
              Recorded in real-time by school NFC gates & teachers
            </p>
          </div>

          {/* Fee Balance & Direct Payment Card */}
          <div className="rounded-3xl border border-stone-200 bg-surface p-6 shadow-sm flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-stone-500 uppercase tracking-wider">
                  Fee Statement
                </span>
                <span
                  className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                    o.fees.summary.balance > 0
                      ? 'bg-rose-100 text-rose-800'
                      : 'bg-lime-100 text-lime-800'
                  }`}
                >
                  {o.fees.summary.balance > 0 ? 'Due Pending' : 'All Settled'}
                </span>
              </div>

              <div className="mt-4">
                <p className="text-xs text-stone-500">Outstanding Balance (all academic years)</p>
                <div className="mt-1 flex items-baseline gap-2">
                  <span
                    className={`text-3xl font-extrabold tracking-tight ${
                      o.fees.summary.balance > 0 ? 'text-rose-600' : 'text-stone-900'
                    }`}
                  >
                    ₹ {Number(o.fees.summary.balance).toLocaleString()}
                  </span>
                </div>
              </div>

              <div className="mt-4 space-y-2">
                {o.fees.records.slice(0, 2).map((fee) => (
                  <div
                    key={fee.id}
                    className="flex items-center justify-between rounded-xl bg-stone-50 p-2.5 text-xs border border-stone-100"
                  >
                    <div>
                      <p className="font-semibold text-stone-800">{fee.fee_type}</p>
                      <p className="text-stone-500 text-xs">Due {fee.due_on || 'Soon'}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-bold text-stone-900">
                        ₹ {Number(fee.amount_due - fee.amount_paid).toLocaleString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <Link
              className="mt-4 block rounded-xl bg-lime-300 px-4 py-3 text-center text-sm font-semibold"
              to={schoolPath('/r/fee_records', a.me?.school?.role) + '?student_id=' + activeChildId}
            >
              View fee statement & receipts
            </Link>
          </div>
        </div>
      ) : null}

      {profileOpen && activeChildId && (
        <StudentProfileDialog studentId={activeChildId} close={() => setProfileOpen(false)} />
      )}
    </div>
  );
}
