import { useEffect, useState } from 'react';
import { useLocation, useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ParentChild, ParentPage, ParentSection } from '@vidyalayaa/contracts';
import { api, downloadReport, useAuth } from '../../lib/auth';
import { schoolPath } from '../../lib/portals';
import { display, label } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { PageHeading, Panel, Loading, ErrorState, Empty, Badge } from '../../components/common';
import { ActionDialog } from '../../components/ActionDialog';
import { enablePush, disablePush } from '../../lib/push';
import SchoolCalendar from '../calendar/SchoolCalendar';
import HomeworkDiary from '../homework/HomeworkDiary';
import Timetable from '../timetable/Timetable';
import UpcomingEvents from '../calendar/UpcomingEvents';
import { schoolToday } from '../calendar/calendar-utils';
import { Dialog } from '../../components/ui/dialog';
import AttendanceCalendar from '../attendance/AttendanceCalendar';
import ParentResults from './ParentResults';
import SubjectMaterials, { type MaterialSubject } from '../materials/SubjectMaterials';
import { PersonAvatar } from '../profiles/PersonAvatar';

const paths: Record<string, ParentSection | 'home'> = {
  '': 'home',
  '/r/students': 'students',
  '/attendance': 'attendance',
  '/attendance/history': 'attendance',
  '/calendar': 'calendar',
  '/r/school_holidays': 'calendar',
  '/academics': 'academics',
  '/r/classes': 'academics',
  '/r/subjects': 'academics',
  '/r/enrollments': 'academics',
  '/r/academic_sessions': 'academics',
  '/r/assignments': 'homework',
  '/r/marks': 'results',
  '/r/exams': 'results',
  '/r/timetable_entries': 'timetable',
  '/r/fee_records': 'fees',
  '/reports': 'reports',
  '/r/announcements': 'announcements',
  '/notifications': 'notifications',
  '/corrections': 'corrections',
};
const titles: Record<ParentSection | 'home', string> = {
  home: 'Their school day, closer to you.',
  students: 'Your child’s details',
  attendance: 'Attendance',
  calendar: 'Calendar',
  academics: 'Academics',
  homework: 'Homework & study materials',
  results: 'Published results',
  timetable: 'Class timetable',
  fees: 'Fees & payment status',
  reports: 'Your child’s reports',
  announcements: 'School announcements',
  notifications: 'Your notifications',
  corrections: 'Correction requests',
};
type Row = Record<string, string | number | boolean | null>;
export default function ParentWorkspace() {
  const a = useAuth(),
    location = useLocation(),
    [params, setParams] = useSearchParams();
  const storageKey = `vidyalayaa.parent-child:${a.me?.id}:${a.school}`;
  const [chosen, setChosen] = useState(() => sessionStorage.getItem(storageKey) || '');
  const family = useQuery({
    queryKey: [a.school, 'parent-children', a.me?.id],
    queryFn: () => api<{ children: ParentChild[] }>('/parent/children'),
    refetchInterval: 30000,
  });
  const children = family.data?.children || [],
    requested = params.get('child_id') || params.get('student_id');
  const selectedId =
    requested || (children.some((c) => c.id === chosen) ? chosen : children[0]?.id);
  const child = children.find((c) => c.id === selectedId);
  useEffect(() => {
    if (child && child.id !== chosen) {
      setChosen(child.id);
      sessionStorage.setItem(storageKey, child.id);
    }
  }, [child, chosen, storageKey]);
  const path = location.pathname.replace(/^\/parent/, '').replace(/\/$/, '');
  const section = paths[path];
  const permissions: Partial<Record<ParentSection, string>> = {
    attendance: 'attendance.read',
    calendar: 'calendar.read',
    academics: 'academics.read',
    homework: 'assignments.read',
    results: 'marks.read',
    timetable: 'timetable.read',
    fees: 'fees.read',
    reports: 'reports.export',
    announcements: 'announcements.read',
    notifications: 'notifications.read',
    corrections: 'attendance.read',
    students: 'students.read',
  };
  if (family.isLoading) return <Loading />;
  if (family.error) return <ErrorState error={family.error} retry={() => family.refetch()} />;
  return (
    <>
      <section
        className="mb-6 rounded-2xl border border-line bg-surface p-5"
        aria-label="Selected child"
      >
        <label className="field-label" htmlFor="parent-child">
          Your child
        </label>
        <select
          id="parent-child"
          className="input max-w-xl"
          value={child?.id || ''}
          onChange={(e) => {
            setChosen(e.target.value);
            sessionStorage.setItem(storageKey, e.target.value);
            const next = new URLSearchParams(params);
            next.delete('student_id');
            next.set('child_id', e.target.value);
            next.delete('page');
            setParams(next);
          }}
        >
          {!child && (
            <option value="">{children.length ? 'Choose your child' : 'No linked children'}</option>
          )}
          {children.map((c) => (
            <option key={c.id} value={c.id}>
              {c.first_name} {c.last_name} · {c.student_code}
            </option>
          ))}
        </select>
        {child && (
          <p className="mt-3 text-sm text-stone-600">
            {child.enrollment
              ? `Class ${child.enrollment.grade} · Section ${child.enrollment.section} · ${child.enrollment.session_name}${child.enrollment.roll_number ? ' · Roll number ' + child.enrollment.roll_number : ''}`
              : 'No current class enrollment'}{' '}
            · Viewing only this child’s school information.
          </p>
        )}
      </section>
      {!children.length ? (
        <Empty
          title="No children linked yet"
          description="Ask your School Admin to link your parent account to your child’s student record."
        />
      ) : !child ? (
        <Empty
          title="Child access unavailable"
          description="Choose one of your linked children above."
        />
      ) : !section ? (
        <Empty
          title="Access unavailable"
          description="Use your parent navigation to view your child’s school information."
        />
      ) : section !== 'home' && !a.me?.school?.permissions.includes(permissions[section]!) ? (
        <Empty title="Access unavailable" />
      ) : (
        <ParentSectionView
          key={`${a.school}:${child.id}:${section}`}
          child={child}
          section={section}
        />
      )}
    </>
  );
}
function ParentSectionView({
  child,
  section,
}: {
  child: ParentChild;
  section: ParentSection | 'home';
}) {
  const a = useAuth(),
    base = `/parent/children/${child.id}`;
  if (section === 'calendar') return <SchoolCalendar basePath={base + '/calendar'} />;
  if (section === 'timetable') return <Timetable basePath={base + '/timetable'} />;
  if (section === 'homework') return <HomeworkDiary basePath={base + '/homework'} />;
  return (
    <>
      <PageHeading
        title={titles[section]}
        description={`${child.first_name} ${child.last_name || ''} · Information shared by your school.`}
      />
      {section === 'attendance' ? (
          <AttendanceCalendar key={child.id} base={`${base}/attendance/calendar`} personal />
      ) : section === 'results' ? (
        <ParentResults child={child} base={base} />
      ) : section === 'home' || section === 'students' ? (
        <ChildDetails child={child} />
      ) : (
        <ParentRecords child={child} section={section} base={base} />
      )}
      {section === 'home' && (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            ['/attendance', 'Attendance'],
            ['/calendar', 'Calendar'],
            ['/r/assignments', 'Homework'],
            ['/r/marks', 'Results'],
            ['/r/timetable_entries', 'Timetable'],
            ['/r/fee_records', 'Fees & receipts'],
          ]
            .filter(
              ([path]) =>
                (path !== '/r/assignments' || a.me?.features.assignments) &&
                (path !== '/r/timetable_entries' || a.me?.features.timetable),
            )
            .map(([path, title]) => (
              <Link
                key={path}
                className="rounded-2xl border border-line bg-surface p-5 font-semibold hover:bg-lime-50"
                to={schoolPath(path, 'parent') + '?child_id=' + child.id}
              >
                {title} →
              </Link>
            ))}
        </div>
      )}
      {section === 'home' && (
        <div className="mt-6">
          <UpcomingEvents basePath={base + '/calendar'} />
        </div>
      )}
    </>
  );
}
function ChildDetails({ child }: { child: ParentChild }) {
  const a = useAuth(),
    q = useQuery({
      queryKey: [a.school, 'parent-profile', child.id],
      queryFn: () =>
        api<{ parent: { full_name: string; email: string; phone: string } | null }>(
          `/parent/children/${child.id}/profile`,
        ),
    });
  const fields = {
    Name: `${child.first_name} ${child.last_name || ''}`,
    'Admission number': child.student_code,
    'Date of birth': child.date_of_birth,
    Gender: label(child.gender),
    Email: child.email,
    'Contact number': child.contact?.contact_phone,
    Address: child.contact?.address,
    Status: label(child.status),
    Class: child.enrollment?.grade,
    Section: child.enrollment?.section,
    'Academic session': child.enrollment?.session_name,
    'Roll number': child.enrollment?.roll_number,
    'Class Teacher': child.enrollment?.class_teacher,
  };
  return (
    <Panel title="Student details" subtitle="Official records are maintained by your school.">
      <div className="px-5 pt-3">
        <PersonAvatar
          kind="student"
          id={child.id}
          photo={child.profile_photo_id}
          name={[child.first_name, child.last_name].filter(Boolean).join(' ')}
          className="size-20 text-2xl"
        />
      </div>
      <dl className="grid gap-5 p-5 sm:grid-cols-2 lg:grid-cols-3">
        {Object.entries(fields).map(([key, value]) => (
          <div key={key}>
            <dt className="text-xs text-stone-500">{key}</dt>
            <dd className="mt-1 break-words font-medium">{value || 'Not recorded'}</dd>
          </div>
        ))}
      </dl>
      {q.error ? (
        <ErrorState error={q.error} />
      ) : (
        q.data?.parent && (
          <div className="border-t border-line p-5">
            <h3 className="font-semibold">Your parent contact</h3>
            <p className="mt-2">{q.data.parent.full_name}</p>
            <p>{q.data.parent.email}</p>
            <p>{q.data.parent.phone}</p>
          </div>
        )
      )}
    </Panel>
  );
}
const columns: Record<string, string[]> = {
  attendance: ['attendance_date', 'attendance_status', 'first_arrival_at', 'last_departure_at'],
  academics: ['subject', 'subject_code', 'teacher', 'class_teacher'],
  results: [
    'examination',
    'assessment_kind',
    'exam_date',
    'subject',
    'score',
    'max_score',
    'remarks',
  ],
  fees: [
    'academic_year',
    'fee_type',
    'installment_label',
    'due_on',
    'amount_due',
    'amount_paid',
    'balance',
    'currency',
    'status',
  ],
  payments: ['receipt_no', 'payment_date', 'amount', 'currency', 'payment_method', 'status'],
  reports: ['kind', 'created_at', 'status', 'format'],
  corrections: ['attendance_date', 'requested_status', 'reason', 'status', 'requested_at'],
};
function ParentRecords({
  child,
  section,
  base,
}: {
  child: ParentChild;
  section: ParentSection;
  base: string;
}) {
  const a = useAuth(),
    [page, setPage] = useState(1),
    [material, setMaterial] = useState<MaterialSubject>(),
    [tab, setTab] = useState('fees'),
    [action, setAction] = useState<Row | null>(null),
    [report, setReport] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const resource = section === 'fees' ? tab : section;
  const q = useQuery({
    queryKey: [a.school, 'parent-records', child.id, resource, page],
    queryFn: () => api<ParentPage<Row>>(`${base}/${resource}?page=${page}&page_size=25`),
    refetchInterval: ['reports', 'notifications'].includes(section) ? 15000 : false,
  });
  async function run(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const today = schoolToday(a.me?.school?.timezone),
    rows = q.data?.data || [];
  return (
    <>
      {error && (
        <p className="notice mb-4" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice mb-4" role="status">
          {notice}
        </p>
      )}
      {section === 'corrections' && (
        <p className="notice mb-4">
          Request a correction from your child’s{' '}
          <Link
            className="underline"
            to={schoolPath('/attendance', 'parent') + '?child_id=' + child.id}
          >
            attendance records
          </Link>
          . The school reviews each request before changing an official record.
        </p>
      )}
      {section === 'reports' && (
        <Button className="mb-4" variant="lime" onClick={() => setReport(true)}>
          Request child report
        </Button>
      )}
      {section === 'fees' && (
        <div className="mb-4 flex gap-2">
          {['fees', 'payments'].map((t) => (
            <Button
              variant={tab === t ? 'lime' : 'outline'}
              key={t}
              onClick={() => {
                setTab(t);
                setPage(1);
              }}
            >
              {t === 'fees' ? 'Fee statement' : 'Payment history & receipts'}
            </Button>
          ))}
        </div>
      )}
      {section === 'notifications' && (
        <div className="mb-4 flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await enablePush();
                setNotice('Notifications enabled on this device.');
              })
            }
          >
            Enable device notifications
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await disablePush();
                setNotice('Notifications disabled on this device.');
              })
            }
          >
            Disable device notifications
          </Button>
        </div>
      )}
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : !rows.length ? (
        <Empty
          title="No records yet"
          description="Records shared by the school for this child will appear here."
        />
      ) : section === 'academics' ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((row) => (
            <button
              type="button"
              key={String(row.id)}
              className="rounded-2xl border border-line bg-surface p-5 text-left hover:border-lime-500 hover:bg-lime-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
              onClick={() =>
                setMaterial({
                  classId: String(row.class_id),
                  subjectId: String(row.subject_id),
                  name: String(row.subject),
                  classLabel: `Class ${row.grade} · Section ${row.section}`,
                })
              }
            >
              <h2 className="font-semibold">{row.subject}</h2>
              <p className="mt-2 text-xs text-stone-500">
                {row.subject_code} · Class {row.grade} · Section {row.section}
              </p>
              <p className="mt-3 text-sm">Teacher · {row.teacher}</p>
              <p className="mt-1 text-sm">
                Class Teacher · {row.class_teacher || 'Not designated'}
              </p>
              <p className="mt-4 text-xs font-semibold">View study materials →</p>
            </button>
          ))}
        </div>
      ) : ['homework', 'announcements', 'notifications'].includes(section) ? (
        <div className="space-y-4">
          {rows.map((row) => (
            <article key={String(row.id)} className="rounded-2xl border border-line bg-surface p-5">
              <h2 className="font-semibold">
                {String(row.title || label(String(row.kind || 'School update')))}
              </h2>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm">
                {String(row.body || row.fee_type || label(String(row.attendance_status || '')))}
              </p>
              <p className="mt-3 text-xs text-stone-500">
                {row.subject ? String(row.subject) + ' · ' : ''}
                {row.due_at
                  ? 'Due ' + display(row.due_at, a.me?.school?.timezone)
                  : row.published_at
                    ? display(row.published_at, a.me?.school?.timezone)
                    : row.created_at
                      ? display(row.created_at, a.me?.school?.timezone)
                      : ''}
              </p>
              {section === 'homework' && row.has_attachment && (
                <Button
                  className="mt-3"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const link = await api<{ url: string }>(`/materials/${row.id}/download`);
                      await downloadReport(link.url, 'study-material');
                    })
                  }
                >
                  Download study material
                </Button>
              )}
            </article>
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {columns[resource]?.map((c) => (
                  <th className="whitespace-nowrap p-4 font-medium" key={c}>
                    {label(c)}
                  </th>
                ))}
                {['attendance', 'reports', 'payments'].includes(resource) && (
                  <th className="p-4">Actions</th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={String(row.id)} className="border-t border-line">
                  {columns[resource]?.map((c) => (
                    <td className="p-4" key={c}>
                      {/status$/.test(c) ? (
                        <Badge>{String(row[c] || 'Not recorded')}</Badge>
                      ) : row[c] == null ? (
                        '—'
                      ) : /_at$/.test(c) ? (
                        display(row[c], a.me?.school?.timezone)
                      ) : (
                        String(row[c])
                      )}
                    </td>
                  ))}
                  {resource === 'attendance' && (
                    <td className="p-4">
                      {a.me?.school?.permissions.includes('attendance.correct_request') && (
                        <Button size="sm" variant="outline" onClick={() => setAction(row)}>
                          Request correction
                        </Button>
                      )}
                    </td>
                  )}
                  {resource === 'reports' && (
                    <td className="p-4">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || row.status !== 'COMPLETED'}
                        onClick={() =>
                          run(async () => {
                            const link = await api<{ url: string }>(`/reports/${row.id}/download`);
                            await downloadReport(
                              link.url,
                              `child-report.${row.format === 'CSV' ? 'csv' : 'pdf'}`,
                            );
                          })
                        }
                      >
                        Download
                      </Button>
                    </td>
                  )}
                  {resource === 'payments' && (
                    <td className="p-4">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            const payment = await api<{
                              receipt_snapshot: Record<string, unknown>;
                            }>(`/fees/payments/${row.id}`);
                            setAction({
                              id: String(row.id),
                              receipt: JSON.stringify(payment.receipt_snapshot),
                            });
                          })
                        }
                      >
                        View receipt
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!!q.data?.total && (
        <div className="mt-4 flex items-center justify-between gap-2 text-sm">
          <span>
            {q.data.total} records · Page {page}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)}>
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={page * 25 >= q.data.total}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
      {material && (
        <SubjectMaterials
          key={child.id + material.classId + material.subjectId}
          subject={material}
          basePath={`${base}/materials`}
          close={() => setMaterial(undefined)}
        />
      )}
      {action && section === 'attendance' && (
        <ActionDialog
          open
          close={() => {
            setAction(null);
            q.refetch();
          }}
          title="Request attendance correction"
          endpoint="/corrections"
          fields={[
            { key: 'daily_attendance_id', type: 'hidden', default: String(action.id) },
            {
              key: 'requested_status',
              options: ['PRESENT', 'LATE', 'HALF_DAY', 'ABSENT', 'EXCUSED'],
              default: String(action.attendance_status),
            },
            { key: 'reason', type: 'textarea' },
          ]}
        />
      )}
      {action && resource === 'payments' && <Receipt row={action} close={() => setAction(null)} />}
      {report && (
        <ActionDialog
          open
          close={() => {
            setReport(false);
            q.refetch();
          }}
          title="Request your child’s report"
          endpoint="/reports"
          fields={[
            { key: 'student_id', type: 'hidden', default: child.id },
            { key: 'kind', options: ['ATTENDANCE', 'ACADEMIC', 'FEES'] },
            {
              key: 'format',
              options: a.me?.features.advanced_reporting ? ['PDF', 'CSV'] : ['PDF'],
              default: 'PDF',
            },
            { key: 'from', type: 'date', default: today.slice(0, 7) + '-01' },
            { key: 'to', type: 'date', default: today },
          ]}
        />
      )}
    </>
  );
}
function Receipt({ row, close }: { row: Row; close: () => void }) {
  const receipt = JSON.parse(String(row.receipt || '{}'));
  return (
    <Dialog open onOpenChange={(v) => !v && close()} title="Payment receipt">
      <dl className="space-y-3">
        {[
          'school_name',
          'student_name',
          'student_code',
          'academic_year',
          'class_label',
          'roll_number',
          'receipt_no',
          'payment_date',
          'payment_method',
          'currency',
          'amount',
          'balance_after',
        ].map((key) => (
          <div className="flex justify-between gap-4" key={key}>
            <dt>{label(key)}</dt>
            <dd className="text-right">{receipt[key] || '—'}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-5 space-y-2">
        {receipt.lines?.map((line: { label: string; amount: string }, i: number) => (
          <p key={i} className="flex justify-between">
            <span>{line.label}</span>
            <span>{line.amount}</span>
          </p>
        ))}
      </div>
    </Dialog>
  );
}
