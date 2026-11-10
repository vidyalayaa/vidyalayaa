import { useState, lazy, Suspense } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Users,
  GraduationCap,
  CalendarCheck2,
  Wallet,
  Radio,
  Clock,
  Phone,
  Mail,
  ShieldCheck,
  CreditCard,
  Plus,
  AlertCircle,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { api, useAuth } from '../../lib/auth';
import { display, label, genderLabel } from '../../lib/utils';
import { Dialog } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Badge, Loading, ErrorState } from '../../components/common';
import { ActionDialog } from '../../components/ActionDialog';
import FeePaymentDialog from './FeePaymentDialog';
import { IssueCardDialog } from './CardActionDialogs';
import { PersonAvatar } from '../profiles/PersonAvatar';
import PhotoEditor from '../profiles/PhotoEditor';
import PersonDetailsForm from '../profiles/PersonDetailsForm';
import type { StudentContact } from '@vidyalayaa/contracts';
const StudentEnrollments = lazy(() => import('../students/StudentEnrollments'));
const FamilyRecordForm = lazy(() =>
  import('./ResourceScreen').then((m) => ({ default: m.ResourceForm })),
);

interface StudentOverview {
  student: {
    id: string;
    student_code: string;
    first_name: string;
    last_name: string | null;
    date_of_birth: string | null;
    gender: string;
    status: string;
    created_at: string;
    email: string | null;
    profile_photo_id?: string | null;
    contact?: StudentContact | null;
  };
  enrollment: {
    id: string;
    class_id: string;
    grade: string;
    section: string;
    roll_number: string | null;
    session_name: string;
    starts_on: string;
  } | null;
  card: {
    id: string;
    card_uid: string;
    status: string;
    issued_at: string;
    blocked_reason: string | null;
  } | null;
  parents: {
    id: string;
    parent_id: string;
    full_name: string;
    email: string | null;
    phone: string | null;
    relationship: string;
    is_primary_contact: boolean;
    can_receive_alerts: boolean;
  }[];
  attendance: {
    today: {
      attendance_status: string;
      movement_status: string;
      first_arrival_at: string | null;
      last_departure_at: string | null;
      needs_review: boolean;
    } | null;
    summary: {
      total: number;
      present: number;
      late: number;
      absent: number;
      percentage: number;
    };
  };
  marks: {
    id: string;
    score: number;
    remarks: string | null;
    exam_name: string;
    max_score: number;
    exam_type: string;
    subject_name: string;
  }[];
  fees: {
    summary: {
      total_due: number;
      total_paid: number;
      balance: number;
      unpaid_count: number;
    };
    records: {
      id: string;
      fee_type: string;
      amount_due: number;
      amount_paid: number;
      due_on: string;
      status: string;
      currency: string;
    }[];
  };
}

export default function StudentProfileDialog({
  studentId,
  close,
}: {
  studentId: string;
  close: () => void;
}) {
  const a = useAuth(),
    qc = useQueryClient(),
    [tab, setTab] = useState<'overview' | 'attendance' | 'academics' | 'fees' | 'card'>('overview'),
    [action, setAction] = useState<string | null>(null),
    [profileEdit, setProfileEdit] = useState<'core' | 'contact' | 'photo'>(),
    [paymentFee, setPaymentFee] = useState<Record<string, unknown> | null>(null);

  const query = useQuery({
    queryKey: [a.school, 'student-overview', studentId],
    queryFn: () => api<StudentOverview>(`/students/${studentId}/overview`),
    staleTime: 0,
  });

  const permissions = a.me?.school?.permissions || [];
  const canManageAttendance = permissions.includes('attendance.manual_write');
  const canManageCards = permissions.includes('cards.manage');
  const canWriteFees = permissions.includes('fees.write');
  const canWriteParents = permissions.includes('parents.write');
  const canManageProfile =
    a.me?.school?.role === 'school_admin' && permissions.includes('students.write');
  const [linkParentOpen, setLinkParentOpen] = useState(false);
  const [familyEdit, setFamilyEdit] = useState<{
      resource: 'parents' | 'student_parents';
      initial: Record<string, unknown>;
    }>(),
    [familyDirty, setFamilyDirty] = useState(false);
  function closeFamilyEdit() {
    if (
      !familyDirty ||
      window.confirm('Close with unsaved changes? The draft stays in this tab.')
    ) {
      setFamilyEdit(undefined);
      setFamilyDirty(false);
    }
  }

  const d = query.data;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={d ? `${d.student.first_name} ${d.student.last_name || ''}` : 'Student Profile'}
      description="Student 360 overview · Academic, attendance, guardian and financial records"
    >
      {query.isLoading ? (
        <Loading />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => query.refetch()} />
      ) : d ? (
        <div className="space-y-6">
          {/* Header Summary Banner */}
          <div className="rounded-2xl border border-stone-200/80 bg-gradient-to-br from-stone-50 via-white to-stone-50/50 p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-center gap-4">
                <PersonAvatar
                  kind="student"
                  id={studentId}
                  photo={d.student.profile_photo_id}
                  name={[d.student.first_name, d.student.last_name].filter(Boolean).join(' ')}
                  className="size-16 rounded-2xl text-xl"
                />
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-xl font-bold text-stone-900">
                      {d.student.first_name} {d.student.last_name || ''}
                    </h2>
                    <Badge>{d.student.status}</Badge>
                  </div>
                  <p className="mt-1 flex items-center gap-2 text-sm text-stone-500">
                    <span className="font-mono text-xs font-semibold text-stone-700">
                      Admission no. {d.student.student_code}
                    </span>
                    <span>·</span>
                    {d.enrollment ? (
                      <span className="font-medium text-stone-700">
                        Grade {d.enrollment.grade}-{d.enrollment.section}
                        {d.enrollment.roll_number ? ` (Roll #${d.enrollment.roll_number})` : ''}
                      </span>
                    ) : (
                      <span className="italic text-stone-400">No active class enrollment</span>
                    )}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {canManageProfile && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setProfileEdit(profileEdit === 'core' ? undefined : 'core')}
                    >
                      Edit student record
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setProfileEdit(profileEdit === 'contact' ? undefined : 'contact')
                      }
                    >
                      Edit contact details
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setProfileEdit(profileEdit === 'photo' ? undefined : 'photo')}
                    >
                      Manage photo
                    </Button>
                  </>
                )}
                {canManageAttendance && (
                  <Button size="sm" variant="outline" onClick={() => setAction('mark_attendance')}>
                    <CalendarCheck2 size={14} />
                    Mark Attendance
                  </Button>
                )}
                {canManageCards && (
                  <Button size="sm" variant="outline" onClick={() => setAction('issue_card')}>
                    <Radio size={14} />
                    {d.card ? 'Replace NFC Card' : 'Issue NFC Card'}
                  </Button>
                )}
              </div>
            </div>

            {/* Quick Metrics Bar */}
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-xl bg-white p-3 border border-stone-100 shadow-xs">
                <span className="text-xs font-medium text-stone-500">30-Day Attendance</span>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-lg font-bold text-stone-900">
                    {d.attendance.summary.percentage}%
                  </span>
                  <span className="text-xs text-stone-400">
                    ({d.attendance.summary.present}/{d.attendance.summary.total} days)
                  </span>
                </div>
              </div>

              <div className="rounded-xl bg-white p-3 border border-stone-100 shadow-xs">
                <span className="text-xs font-medium text-stone-500">Today's Status</span>
                <div className="mt-1">
                  <Badge>
                    {d.attendance.today ? d.attendance.today.attendance_status : 'NOT_MARKED'}
                  </Badge>
                </div>
              </div>

              <div className="rounded-xl bg-white p-3 border border-stone-100 shadow-xs">
                <span className="text-xs font-medium text-stone-500">Active NFC Card</span>
                <div className="mt-1">
                  {d.card ? (
                    <span className="inline-flex items-center gap-1.5 font-mono text-xs font-semibold text-stone-800">
                      <span
                        className={`h-2 w-2 rounded-full ${
                          d.card.status === 'ACTIVE' ? 'bg-green-500' : 'bg-rose-500'
                        }`}
                      />
                      {d.card.card_uid}
                    </span>
                  ) : (
                    <span className="text-xs text-stone-400">Not assigned</span>
                  )}
                </div>
              </div>

              <div className="rounded-xl bg-white p-3 border border-stone-100 shadow-xs">
                <span className="text-xs font-medium text-stone-500">Outstanding Fees</span>
                <div className="mt-1">
                  <span
                    className={`text-sm font-bold ${
                      Number(d.fees.summary.balance) > 0 ? 'text-amber-700' : 'text-green-700'
                    }`}
                  >
                    ₹{Number(d.fees.summary.balance).toLocaleString('en-IN')}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Navigation Tabs */}
          <div className="flex flex-wrap border-b border-stone-200 text-sm font-medium">
            <button
              className={`pb-3 px-4 transition-colors ${
                tab === 'overview'
                  ? 'border-b-2 border-stone-900 font-semibold text-stone-900'
                  : 'text-stone-500 hover:text-stone-800'
              }`}
              onClick={() => setTab('overview')}
            >
              Overview & Guardians
            </button>
            <button
              className={`pb-3 px-4 transition-colors ${
                tab === 'attendance'
                  ? 'border-b-2 border-stone-900 font-semibold text-stone-900'
                  : 'text-stone-500 hover:text-stone-800'
              }`}
              onClick={() => setTab('attendance')}
            >
              Attendance Record
            </button>
            <button
              className={`pb-3 px-4 transition-colors ${
                tab === 'academics'
                  ? 'border-b-2 border-stone-900 font-semibold text-stone-900'
                  : 'text-stone-500 hover:text-stone-800'
              }`}
              onClick={() => setTab('academics')}
            >
              Academic Results
            </button>
            <button
              className={`pb-3 px-4 transition-colors ${
                tab === 'fees'
                  ? 'border-b-2 border-stone-900 font-semibold text-stone-900'
                  : 'text-stone-500 hover:text-stone-800'
              }`}
              onClick={() => setTab('fees')}
            >
              Fees & Billing
            </button>
          </div>

          {/* TAB: Overview & Guardians */}
          {canManageProfile && profileEdit === 'photo' && (
            <PhotoEditor kind="student" id={studentId} photo={d.student.profile_photo_id} />
          )}
          {canManageProfile && profileEdit === 'contact' && (
            <PersonDetailsForm
              kind="student"
              id={studentId}
              initial={d.student.contact || {}}
              onDone={() => setProfileEdit(undefined)}
            />
          )}
          {canManageProfile && profileEdit === 'core' && (
            <Suspense fallback={<Loading />}>
              <FamilyRecordForm
                resource="students"
                initial={{ ...d.student }}
                done={async () => {
                  setProfileEdit(undefined);
                  await qc.invalidateQueries({ queryKey: [a.school] });
                }}
              />
            </Suspense>
          )}
          {tab === 'overview' && (
            <div className="space-y-5">
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-stone-400">
                    Linked Parents & Guardians
                  </h3>
                  {canWriteParents && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs"
                      onClick={() => setLinkParentOpen(true)}
                    >
                      <Plus size={13} /> Link Parent
                    </Button>
                  )}
                </div>
                {d.parents.length ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {d.parents.map((p) => (
                      <div
                        key={p.id}
                        className="rounded-xl border border-stone-200/90 bg-white p-4 shadow-xs"
                      >
                        <div className="flex items-center justify-between">
                          <h4 className="font-semibold text-stone-900">{p.full_name}</h4>
                          <span className="rounded-md bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-600">
                            {p.relationship}
                          </span>
                        </div>
                        <div className="mt-3 space-y-1 text-xs text-stone-600">
                          {p.phone && (
                            <p className="flex items-center gap-2">
                              <Phone size={13} className="text-stone-400" />
                              <a href={`tel:${p.phone}`} className="hover:underline text-stone-800">
                                {p.phone}
                              </a>
                            </p>
                          )}
                          {p.email && (
                            <p className="flex items-center gap-2">
                              <Mail size={13} className="text-stone-400" />
                              <a
                                href={`mailto:${p.email}`}
                                className="hover:underline text-stone-800"
                              >
                                {p.email}
                              </a>
                            </p>
                          )}
                        </div>
                        <div className="mt-3 flex items-center gap-2 pt-2 border-t border-stone-100 text-[11px] text-stone-500">
                          {p.is_primary_contact && (
                            <span className="text-lime-700 font-medium">★ Primary Contact</span>
                          )}
                          {p.can_receive_alerts && <span>· SMS/Push Alerts On</span>}
                        </div>
                        {canWriteParents && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              aria-label={`Edit parent details for ${p.full_name}`}
                              onClick={() => {
                                setFamilyDirty(false);
                                setFamilyEdit({
                                  resource: 'parents',
                                  initial: {
                                    id: p.parent_id,
                                    full_name: p.full_name,
                                    email: p.email,
                                    phone: p.phone,
                                    status: 'ACTIVE',
                                  },
                                });
                              }}
                            >
                              Edit parent details
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`Edit connection for ${p.full_name}`}
                              onClick={() => {
                                setFamilyDirty(false);
                                setFamilyEdit({
                                  resource: 'student_parents',
                                  initial: {
                                    id: p.id,
                                    student_id: studentId,
                                    parent_id: p.parent_id,
                                    relationship: p.relationship,
                                    is_primary_contact: p.is_primary_contact,
                                    can_receive_alerts: p.can_receive_alerts,
                                    status: 'ACTIVE',
                                  },
                                });
                              }}
                            >
                              Edit connection
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-stone-200 p-6 text-center text-sm text-stone-500">
                    No family connections linked to this student yet.
                  </div>
                )}
              </section>

              <section className="rounded-xl border border-stone-100 bg-stone-50/70 p-4 text-xs text-stone-600">
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <div>
                    <span className="font-semibold text-stone-700">Gender:</span>{' '}
                    {genderLabel(d.student.gender)}
                  </div>
                  <div>
                    <span className="font-semibold text-stone-700">Date of Birth:</span>{' '}
                    {d.student.date_of_birth
                      ? display(d.student.date_of_birth.slice(0, 10))
                      : 'Not specified'}
                  </div>
                  <div className="break-words">
                    <span className="font-semibold text-stone-700">Student email:</span>{' '}
                    {d.student.email || 'Not specified'}
                  </div>
                  {d.student.contact && (
                    <>
                      <div className="break-words">
                        <span className="font-semibold text-stone-700">Contact number</span>{' '}
                        {d.student.contact.contact_phone || 'Not recorded'}
                      </div>
                      <div className="break-words">
                        <span className="font-semibold text-stone-700">Address</span>{' '}
                        {d.student.contact.address || 'Not recorded'}
                      </div>
                    </>
                  )}
                  <div>
                    <span className="font-semibold text-stone-700">Enrollment Date:</span>{' '}
                    {d.enrollment?.starts_on ? display(d.enrollment.starts_on.slice(0, 10)) : '—'}
                  </div>
                  <div>
                    <span className="font-semibold text-stone-700">Academic Session:</span>{' '}
                    {d.enrollment?.session_name || 'Current'}
                  </div>
                </div>
              </section>
              {a.me?.school?.role === 'school_admin' && permissions.includes('students.write') && (
                <Suspense fallback={<Loading />}>
                  <StudentEnrollments studentId={studentId} />
                </Suspense>
              )}
            </div>
          )}

          {/* TAB: Attendance */}
          {tab === 'attendance' && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 text-center">
                <div className="rounded-xl bg-stone-50 p-3">
                  <span className="text-xs text-stone-500">Total School Days</span>
                  <p className="mt-1 text-xl font-bold text-stone-900">
                    {d.attendance.summary.total}
                  </p>
                </div>
                <div className="rounded-xl bg-green-50 p-3">
                  <span className="text-xs text-green-700">Present</span>
                  <p className="mt-1 text-xl font-bold text-green-900">
                    {d.attendance.summary.present}
                  </p>
                </div>
                <div className="rounded-xl bg-amber-50 p-3">
                  <span className="text-xs text-amber-700">Late Arrivals</span>
                  <p className="mt-1 text-xl font-bold text-amber-900">
                    {d.attendance.summary.late}
                  </p>
                </div>
                <div className="rounded-xl bg-rose-50 p-3">
                  <span className="text-xs text-rose-700">Absences</span>
                  <p className="mt-1 text-xl font-bold text-rose-900">
                    {d.attendance.summary.absent}
                  </p>
                </div>
              </div>

              {d.attendance.today && (
                <div className="rounded-xl border border-stone-200 bg-white p-4">
                  <h4 className="font-semibold text-stone-900 text-sm">
                    Today's Recorded Movement
                  </h4>
                  <div className="mt-2 grid grid-cols-2 gap-4 text-xs sm:grid-cols-4">
                    <div>
                      <span className="text-stone-500">Status</span>
                      <p className="mt-0.5 font-medium">{d.attendance.today.attendance_status}</p>
                    </div>
                    <div>
                      <span className="text-stone-500">Gate Movement</span>
                      <p className="mt-0.5 font-medium">{d.attendance.today.movement_status}</p>
                    </div>
                    <div>
                      <span className="text-stone-500">First Arrival</span>
                      <p className="mt-0.5 font-medium">
                        {d.attendance.today.first_arrival_at
                          ? new Date(d.attendance.today.first_arrival_at).toLocaleTimeString(
                              'en-IN',
                              {
                                hour: 'numeric',
                                minute: '2-digit',
                                timeZone: a.me?.school?.timezone,
                              },
                            )
                          : '—'}
                      </p>
                    </div>
                    <div>
                      <span className="text-stone-500">Last Departure</span>
                      <p className="mt-0.5 font-medium">
                        {d.attendance.today.last_departure_at
                          ? new Date(d.attendance.today.last_departure_at).toLocaleTimeString(
                              'en-IN',
                              {
                                hour: 'numeric',
                                minute: '2-digit',
                                timeZone: a.me?.school?.timezone,
                              },
                            )
                          : '—'}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB: Academics */}
          {tab === 'academics' && (
            <div className="space-y-4">
              {d.marks.length ? (
                <div className="overflow-x-auto rounded-xl border border-stone-200">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-stone-50 border-b border-stone-200 font-semibold text-stone-600">
                      <tr>
                        <th className="p-3">Exam</th>
                        <th className="p-3">Subject</th>
                        <th className="p-3">Score</th>
                        <th className="p-3">Percentage</th>
                        <th className="p-3">Remarks</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-stone-100">
                      {d.marks.map((m) => {
                        const pct = Math.round((m.score / m.max_score) * 100);
                        return (
                          <tr key={m.id} className="hover:bg-stone-50/50">
                            <td className="p-3 font-medium text-stone-900">{m.exam_name}</td>
                            <td className="p-3 text-stone-700">{m.subject_name}</td>
                            <td className="p-3 font-mono font-medium">
                              {m.score} / {m.max_score}
                            </td>
                            <td className="p-3">
                              <span
                                className={`rounded px-1.5 py-0.5 font-semibold ${
                                  pct >= 75
                                    ? 'bg-green-100 text-green-800'
                                    : pct >= 50
                                      ? 'bg-amber-100 text-amber-800'
                                      : 'bg-rose-100 text-rose-800'
                                }`}
                              >
                                {pct}%
                              </span>
                            </td>
                            <td className="p-3 text-stone-500">{m.remarks || '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-stone-200 p-8 text-center text-sm text-stone-500">
                  No published exam marks recorded for this student yet.
                </div>
              )}
            </div>
          )}

          {/* TAB: Fees & Billing */}
          {tab === 'fees' && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="rounded-xl bg-stone-50 p-3">
                  <span className="text-xs text-stone-500">Total Invoiced</span>
                  <p className="mt-1 text-base font-bold text-stone-900">
                    ₹{Number(d.fees.summary.total_due).toLocaleString('en-IN')}
                  </p>
                </div>
                <div className="rounded-xl bg-green-50 p-3">
                  <span className="text-xs text-green-700">Total Paid</span>
                  <p className="mt-1 text-base font-bold text-green-900">
                    ₹{Number(d.fees.summary.total_paid).toLocaleString('en-IN')}
                  </p>
                </div>
                <div className="rounded-xl bg-amber-50 p-3">
                  <span className="text-xs text-amber-700">Balance Due</span>
                  <p className="mt-1 text-base font-bold text-amber-900">
                    ₹{Number(d.fees.summary.balance).toLocaleString('en-IN')}
                  </p>
                </div>
              </div>

              {d.fees.records.length ? (
                <div className="overflow-x-auto rounded-xl border border-stone-200">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-stone-50 border-b border-stone-200 font-semibold text-stone-600">
                      <tr>
                        <th className="p-3">Fee Type</th>
                        <th className="p-3">Amount Due</th>
                        <th className="p-3">Amount Paid</th>
                        <th className="p-3">Due Date</th>
                        <th className="p-3">Status</th>
                        {canWriteFees && <th className="p-3 text-right">Action</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-stone-100">
                      {d.fees.records.map((f) => (
                        <tr key={f.id} className="hover:bg-stone-50/50">
                          <td className="p-3 font-medium text-stone-900">{f.fee_type}</td>
                          <td className="p-3 font-mono">₹{f.amount_due}</td>
                          <td className="p-3 font-mono text-green-700">₹{f.amount_paid}</td>
                          <td className="p-3 text-stone-600">{display(f.due_on)}</td>
                          <td className="p-3">
                            <Badge>{f.status}</Badge>
                          </td>
                          {canWriteFees && (
                            <td className="p-3 text-right">
                              {f.status !== 'PAID' && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => setPaymentFee(f)}
                                >
                                  Record Payment
                                </Button>
                              )}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-stone-200 p-8 text-center text-sm text-stone-500">
                  No fee records assigned.
                </div>
              )}
            </div>
          )}

          {/* Action Modals */}
          {action === 'mark_attendance' && (
            <ActionDialog
              open
              close={() => {
                setAction(null);
                qc.invalidateQueries({ queryKey: [a.school, 'student-overview', studentId] });
              }}
              title={`Mark Attendance · ${d.student.first_name}`}
              endpoint="/attendance/manual"
              fields={[
                { key: 'student_id', type: 'hidden', default: studentId },
                {
                  key: 'date',
                  type: 'date',
                  default: new Intl.DateTimeFormat('en-CA', {
                    timeZone: a.me?.school?.timezone || 'Asia/Kolkata',
                  }).format(new Date()),
                },
                {
                  key: 'status',
                  options: ['PRESENT', 'LATE', 'HALF_DAY', 'ABSENT', 'EXCUSED'],
                  default: 'PRESENT',
                },
                { key: 'reason', type: 'textarea' },
              ]}
            />
          )}

          {action === 'issue_card' && (
            <IssueCardDialog
              open
              close={() => {
                setAction(null);
                qc.invalidateQueries({ queryKey: [a.school, 'student-overview', studentId] });
              }}
              initialStudentId={studentId}
            />
          )}

          {paymentFee && (
            <FeePaymentDialog
              fee={paymentFee as any}
              close={() => {
                setPaymentFee(null);
                qc.invalidateQueries({ queryKey: [a.school, 'student-overview', studentId] });
              }}
            />
          )}

          {familyEdit && (
            <Dialog
              open
              title={
                familyEdit.resource === 'parents' ? 'Edit parent details' : 'Edit family connection'
              }
              description="Manage this student's family directly from their profile."
              onOpenChange={(v) => {
                if (!v) closeFamilyEdit();
              }}
            >
              <Suspense fallback={<Loading />}>
                <FamilyRecordForm
                  key={`${familyEdit.resource}:${familyEdit.initial.id}`}
                  resource={familyEdit.resource}
                  initial={familyEdit.initial}
                  hiddenFields={
                    familyEdit.resource === 'parents'
                      ? ['status']
                      : ['student_id', 'parent_id', 'status']
                  }
                  onDirtyChange={setFamilyDirty}
                  cancel={closeFamilyEdit}
                  done={async () => {
                    await qc.invalidateQueries({ queryKey: [a.school] });
                    setFamilyDirty(false);
                    setFamilyEdit(undefined);
                  }}
                />
              </Suspense>
            </Dialog>
          )}
          {linkParentOpen && (
            <ActionDialog
              open
              close={() => {
                setLinkParentOpen(false);
                qc.invalidateQueries({ queryKey: [a.school, 'student-overview', studentId] });
              }}
              title={`Link Parent to ${d.student.first_name}`}
              endpoint="/resources/student_parents"
              fields={[
                { key: 'student_id', type: 'hidden', default: studentId },
                { key: 'parent_id', lookup: '/resources/parents' },
                {
                  key: 'relationship',
                  options: ['MOTHER', 'FATHER', 'GUARDIAN', 'OTHER'],
                  default: 'MOTHER',
                },
                { key: 'is_primary_contact', type: 'checkbox', default: 'true' },
                { key: 'can_receive_alerts', type: 'checkbox', default: 'true' },
                { key: 'status', options: ['ACTIVE', 'REVOKED'], default: 'ACTIVE' },
              ]}
            />
          )}
        </div>
      ) : null}
    </Dialog>
  );
}
