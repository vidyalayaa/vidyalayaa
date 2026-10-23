import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Plus, Wallet, Receipt, Bus, Download } from 'lucide-react';
import type {
  Page,
  FeeStatement,
  FeeSummary,
  FeePayment,
  FeeAssessment,
} from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { PageHeading, Empty, ErrorState, Loading } from '../../components/common';
import { Button } from '../../components/ui/button';
import Pagination from '../../components/Pagination';
import FeeReceipt, { feeAmount } from './FeeReceipt';
import CollectPayment from './CollectPayment';
import FeeStructureForm, { type FeeClass, type FeeStructure } from './FeeStructureForm';
import { RouteForm, TransportForm, FeeReason, type FeeRoute } from './TransportForms';
interface Session {
  id: string;
  name: string;
  starts_on: string;
  ends_on: string;
  is_current: boolean;
}
interface Student {
  id: string;
  name: string;
  student_code: string;
}
interface Report {
  summary: FeeSummary[];
  collections: {
    currency: string;
    category: string;
    payment_date: string;
    receipts: number;
    collected: string;
  }[];
  records: Page<FeeAssessment>;
}
const day = (v: unknown) => String(v || '').slice(0, 10);
export function FeeTotals({ rows }: { rows: FeeSummary[] }) {
  return (
    <div className="space-y-4">
      {rows.map((r) => (
        <div key={r.currency} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            ['Total expected', r.expected],
            ['Total paid', r.collected],
            ['Remaining balance', r.outstanding],
            ['Overdue', r.overdue],
          ].map(([label, value]) => (
            <div key={label} className="rounded-2xl border border-stone-200 bg-white p-4">
              <p className="text-xs text-stone-500">{label}</p>
              <p className="mt-2 break-words text-lg font-semibold">
                {feeAmount(value, r.currency)}
              </p>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
function AssessmentTable({
  rows,
  today,
  manage,
  onVoid,
  onRemind,
}: {
  rows: FeeAssessment[];
  today: string;
  manage: boolean;
  onVoid: (f: FeeAssessment) => void;
  onRemind?: (f: FeeAssessment) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-stone-200">
      <table className="w-full min-w-[650px] text-left text-sm">
        <caption className="sr-only">Assessed fee installments</caption>
        <thead className="bg-stone-50">
          <tr>
            {[
              'Fee / installment',
              'Due date',
              'Payable',
              'Paid',
              'Balance',
              'Status',
              ...(manage ? ['Actions'] : []),
            ].map((c) => (
              <th key={c} className="p-3 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => {
            const balance = Number(f.amount_due) - Number(f.amount_paid),
              status = f.voided_at
                ? 'Voided'
                : f.status === 'WAIVED'
                  ? 'Waived'
                  : balance === 0
                    ? 'Paid'
                    : day(f.due_on) < today
                      ? 'Overdue'
                      : Number(f.amount_paid) > 0
                        ? 'Partially paid'
                        : 'Pending';
            return (
              <tr key={f.id} className="border-t border-stone-100">
                <td className="p-3">
                  <strong className="font-medium">{f.fee_type}</strong>
                  <span className="mt-1 block text-xs text-stone-500">
                    {f.installment_label || f.category}
                  </span>
                </td>
                <td className="p-3">{day(f.due_on)}</td>
                <td className="p-3">{feeAmount(f.amount_due, f.currency)}</td>
                <td className="p-3">{feeAmount(f.amount_paid, f.currency)}</td>
                <td className="p-3">
                  {feeAmount(f.status === 'WAIVED' ? 0 : balance, f.currency)}
                </td>
                <td className="p-3">
                  <span
                    className={`whitespace-nowrap rounded-full px-2 py-1 text-xs ${status === 'Overdue' ? 'bg-rose-50 text-rose-800' : status === 'Paid' ? 'bg-lime-100 text-lime-900' : 'bg-stone-100 text-stone-700'}`}
                  >
                    {status}
                  </span>
                </td>
                {manage && (
                  <td className="p-3">
                    {onRemind && !f.voided_at && !['PAID', 'WAIVED'].includes(f.status) && (
                      <Button size="sm" variant="outline" onClick={() => onRemind(f)}>
                        Remind
                      </Button>
                    )}
                    {!f.voided_at && f.status !== 'WAIVED' && Number(f.amount_paid) === 0 && (
                      <Button size="sm" variant="ghost" onClick={() => onVoid(f)}>
                        Void
                      </Button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {!rows.length && <p className="p-5 text-sm text-stone-500">No fee installments assessed.</p>}
    </div>
  );
}
export default function Fees() {
  const a = useAuth(),
    qc = useQueryClient(),
    [params] = useSearchParams(),
    role = a.me?.school?.role,
    manage =
      ['school_admin', 'finance_staff'].includes(role || '') &&
      !!a.me?.school?.permissions.includes('fees.write'),
    staff = ['school_admin', 'finance_staff', 'principal'].includes(role || ''),
    [tab, setTab] = useState('students'),
    [year, setYear] = useState(params.get('academic_session_id') || ''),
    [grade, setGrade] = useState(''),
    [classId, setClassId] = useState(''),
    [studentId, setStudentId] = useState(params.get('student_id') || ''),
    [search, setSearch] = useState(''),
    [studentPage, setStudentPage] = useState(1),
    [reportPage, setReportPage] = useState(1),
    [category, setCategory] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [structureOpen, setStructureOpen] = useState(false),
    [routeEdit, setRouteEdit] = useState<FeeRoute | null | undefined>(),
    [transportOpen, setTransportOpen] = useState(false),
    [payOpen, setPayOpen] = useState(false),
    [receipt, setReceipt] = useState<FeePayment>(),
    [action, setAction] = useState<{ endpoint: string; title: string; transport?: boolean }>(),
    [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const allowed = !!a.me?.school?.permissions.includes('fees.read');
  const options = useQuery({
    queryKey: [a.school, 'fee-options'],
    queryFn: () => api<{ sessions: Session[]; classes: FeeClass[] }>('/fees/options'),
    enabled: allowed,
  });
  useEffect(() => {
    if (!year && options.data?.sessions.length)
      setYear((options.data.sessions.find((s) => s.is_current) || options.data.sessions[0]).id);
  }, [year, options.data]);
  const session = options.data?.sessions.find((s) => s.id === year),
    classes = options.data?.classes.filter((c) => c.academic_session_id === year) || [],
    grades = [...new Set(classes.map((c) => c.grade))],
    sections = classes.filter((c) => c.grade === grade),
    selectedClass = classes.find((c) => c.id === classId);
  const students = useQuery({
    queryKey: [a.school, 'fee-students', year, grade, classId, search, studentPage],
    queryFn: () =>
      api<Page<Student>>(
        `/fees/students?academic_session_id=${year}&page=${studentPage}&page_size=100${classId ? '&class_id=' + classId : ''}${grade ? '&grade=' + encodeURIComponent(grade) : ''}${search ? '&search=' + encodeURIComponent(search) : ''}`,
      ),
    enabled: allowed && !!year,
  });
  useEffect(() => {
    if (!staff && !studentId && students.data?.data.length === 1)
      setStudentId(students.data.data[0].id);
  }, [students.data, studentId, staff]);
  const statement = useQuery({
    queryKey: [a.school, 'fee-statement', studentId, year],
    queryFn: () => api<FeeStatement>(`/fees/students/${studentId}?academic_session_id=${year}`),
    enabled: allowed && !!studentId && !!year,
  });
  const structures = useQuery({
      queryKey: [a.school, 'fee-structures', year, grade],
      queryFn: () =>
        api<Page<FeeStructure>>(
          `/fees/structures?academic_session_id=${year}&grade=${encodeURIComponent(grade)}`,
        ),
      enabled: allowed && staff && !!year && !!grade,
    }),
    latest = structures.data?.data[0];
  const routes = useQuery({
    queryKey: [a.school, 'fee-routes'],
    queryFn: () => api<{ data: FeeRoute[] }>('/fees/routes'),
    enabled: allowed && staff,
  });
  const reportParams = new URLSearchParams({
    ...(year ? { academic_session_id: year } : {}),
    ...(grade ? { grade } : {}),
    ...(classId ? { class_id: classId } : {}),
    ...(studentId ? { student_id: studentId } : {}),
    ...(search ? { search } : {}),
    ...(category ? { category } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    page: String(reportPage),
  }).toString();
  const report = useQuery({
    queryKey: [a.school, 'fee-report', reportParams],
    queryFn: () => api<Report>('/fees/reports?' + reportParams),
    enabled: allowed && staff && !!year && (tab === 'reports' || tab === 'students'),
  });
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: a.me?.school?.timezone || 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const assessment = async () => {
    if (!latest || !classId) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const b = {
          structure_id: latest.id,
          class_id: classId,
          ...(studentId ? { student_id: studentId } : {}),
        },
        preview = await api<{ installments: number; amount: string }>('/fees/assessments/preview', {
          method: 'POST',
          body: JSON.stringify(b),
        });
      if (!preview.installments) {
        setMessage(
          'All matching installments are already assessed or outside the enrollment dates.',
        );
        return;
      }
      if (
        !window.confirm(
          `Create ${preview.installments} new installments totalling ${feeAmount(preview.amount)} for ${studentId ? 'this student' : 'the selected section'}? Existing assessments stay unchanged.`,
        )
      )
        return;
      const result = await api<{ created: number }>('/fees/assessments', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(b),
      });
      await qc.invalidateQueries({ queryKey: [a.school] });
      setMessage(`${result.created} installments assessed. Existing charges were preserved.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    setError('');
    setBusy(true);
    try {
      const file = await api<{ filename: string; csv: string }>(
          '/fees/reports/export?' + reportParams,
        ),
        url = URL.createObjectURL(new Blob([file.csv], { type: 'text/csv;charset=utf-8;' })),
        link = document.createElement('a');
      link.href = url;
      link.download = file.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remind = async (f: FeeAssessment) => {
    setError('');
    try {
      const r = await api<{ queued: boolean }>(`/fees/${f.id}/remind`, { method: 'POST' });
      setMessage(r.queued ? 'Fee reminder queued.' : 'A reminder was already queued today.');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!allowed)
    return (
      <Empty title="Fee access unavailable" description="Choose an authorized school workspace." />
    );
  return (
    <>
      <PageHeading
        title={staff ? 'Fees, clearly accounted for.' : 'Your student fee statement.'}
        description={
          staff
            ? 'Class fee structures, student installments, transport and recorded collections.'
            : 'View your academic and transport fees, due dates and school-issued receipts.'
        }
      />
      {staff && (
        <nav
          aria-label="Fee management"
          className="mb-6 flex gap-2 overflow-x-auto border-b border-stone-200"
        >
          {[
            ['students', 'Student fees'],
            ['structures', 'Class fee structures'],
            ['transport', 'Transport routes'],
            ['reports', 'Dashboard & reports'],
          ].map(([key, label]) => (
            <button
              key={key}
              className={`whitespace-nowrap border-b-2 px-4 py-3 text-sm ${tab === key ? 'border-lime-500 font-semibold' : 'border-transparent text-stone-600'}`}
              aria-current={tab === key ? 'page' : undefined}
              onClick={() => {
                setTab(key);
                setError('');
                setMessage('');
              }}
            >
              {label}
            </button>
          ))}
        </nav>
      )}
      <section
        aria-label="Fee selection"
        className="mb-6 grid gap-4 rounded-2xl border border-stone-200 bg-white p-5 sm:grid-cols-2 xl:grid-cols-4"
      >
        <label className="text-sm">
          Academic year
          <select
            className="input mt-2"
            value={year}
            onChange={(e) => {
              setYear(e.target.value);
              setGrade('');
              setClassId('');
              setStudentId('');
              setStudentPage(1);
              setReportPage(1);
            }}
          >
            <option value="">Select academic year</option>
            {options.data?.sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Class
          <select
            className="input mt-2"
            value={grade}
            onChange={(e) => {
              setGrade(e.target.value);
              setClassId('');
              setStudentId('');
              setStudentPage(1);
              setReportPage(1);
            }}
          >
            <option value="">{staff ? 'All classes / select class' : 'Your classes'}</option>
            {grades.map((g) => (
              <option key={g} value={g}>
                Class {g}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Section
          <select
            className="input mt-2"
            value={classId}
            disabled={!grade}
            onChange={(e) => {
              setClassId(e.target.value);
              setStudentId('');
              setStudentPage(1);
              setReportPage(1);
            }}
          >
            <option value="">All sections</option>
            {sections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.section}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Student
          <select
            className="input mt-2"
            value={studentId}
            onChange={(e) => {
              setStudentId(e.target.value);
              setReportPage(1);
            }}
          >
            <option value="">Choose a student</option>
            {studentId &&
              !students.data?.data.some((s) => s.id === studentId) &&
              statement.data && <option value={studentId}>{statement.data.student.name}</option>}
            {students.data?.data.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.student_code}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm sm:col-span-2">
          {tab === 'reports'
            ? 'Search student, admission number, class or receipt'
            : 'Find student by name or admission number'}
          <input
            className="input mt-2"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setStudentPage(1);
              setReportPage(1);
            }}
            placeholder="Type to search…"
          />
        </label>
        {(students.data?.total || 0) > 100 && (
          <div className="sm:col-span-2">
            <Pagination
              page={studentPage}
              total={students.data!.total}
              pageSize={100}
              onPage={setStudentPage}
            />
          </div>
        )}
      </section>
      {error && (
        <p role="alert" className="notice mb-5 text-rose-800">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="notice mb-5">
          {message}
        </p>
      )}
      {options.isLoading ? (
        <Loading />
      ) : options.error ? (
        <ErrorState error={options.error} retry={() => options.refetch()} />
      ) : students.error ? (
        <ErrorState error={students.error} retry={() => students.refetch()} />
      ) : null}
      {tab === 'students' && (
        <div className="space-y-6">
          {staff && !studentId && report.data && <FeeTotals rows={report.data.summary} />}
          {!studentId ? (
            <Empty
              title="Choose a student"
              description="Select the academic year, class and section, then a student to view their complete fee statement."
            />
          ) : statement.isLoading ? (
            <Loading />
          ) : statement.error ? (
            <ErrorState error={statement.error} retry={() => statement.refetch()} />
          ) : (
            statement.data && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-semibold">{statement.data.student.name}</h2>
                    <p className="mt-1 text-sm text-stone-500">
                      {statement.data.student.student_code} · {session?.name}
                    </p>
                  </div>
                  {manage && (
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" onClick={() => setTransportOpen(true)}>
                        <Bus size={15} />
                        Assign transport
                      </Button>
                      <Button
                        variant="lime"
                        disabled={
                          !statement.data.assessments.some(
                            (f) =>
                              !f.voided_at &&
                              f.status !== 'WAIVED' &&
                              Number(f.amount_due) > Number(f.amount_paid),
                          )
                        }
                        onClick={() => setPayOpen(true)}
                      >
                        <Wallet size={15} />
                        Record payment
                      </Button>
                    </div>
                  )}
                </div>
                <FeeTotals rows={statement.data.summary} />
                <section
                  className="rounded-2xl border border-stone-200 bg-white p-5"
                  aria-label="Upcoming fee installments"
                >
                  <h3 className="font-semibold">Upcoming installments</h3>
                  {statement.data.assessments.some(
                    (f) =>
                      !f.voided_at &&
                      f.status !== 'WAIVED' &&
                      Number(f.amount_due) > Number(f.amount_paid) &&
                      day(f.due_on) >= today,
                  ) ? (
                    <ul className="mt-3 space-y-3 text-sm">
                      {statement.data.assessments
                        .filter(
                          (f) =>
                            !f.voided_at &&
                            f.status !== 'WAIVED' &&
                            Number(f.amount_due) > Number(f.amount_paid) &&
                            day(f.due_on) >= today,
                        )
                        .slice(0, 3)
                        .map((f) => (
                          <li key={f.id} className="flex flex-wrap justify-between gap-2">
                            <span>
                              {f.fee_type} · Due {day(f.due_on)}
                            </span>
                            <strong>
                              {feeAmount(Number(f.amount_due) - Number(f.amount_paid), f.currency)}
                            </strong>
                          </li>
                        ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm text-stone-500">
                      No upcoming unpaid installments. Any overdue amounts are shown in the
                      statement below.
                    </p>
                  )}
                </section>
                <section className="space-y-3">
                  <h3 className="text-lg font-semibold">Academic fees</h3>
                  <AssessmentTable
                    rows={statement.data.assessments.filter((f) => f.category !== 'TRANSPORT')}
                    today={today}
                    manage={manage}
                    onRemind={role === 'school_admin' ? remind : undefined}
                    onVoid={(f) =>
                      setAction({
                        endpoint: `/fees/assessments/${f.id}/void`,
                        title: 'Void fee assessment',
                      })
                    }
                  />
                </section>
                <section className="space-y-3">
                  <h3 className="text-lg font-semibold">Transport fees</h3>
                  {statement.data.summary.map((s) => (
                    <p className="text-sm text-stone-600" key={s.currency}>
                      Transport payable {feeAmount(s.transport_expected, s.currency)} · Paid{' '}
                      {feeAmount(s.transport_paid, s.currency)} · Pending{' '}
                      {feeAmount(s.transport_outstanding, s.currency)}
                    </p>
                  ))}
                  <AssessmentTable
                    rows={statement.data.assessments.filter((f) => f.category === 'TRANSPORT')}
                    today={today}
                    manage={manage}
                    onRemind={role === 'school_admin' ? remind : undefined}
                    onVoid={(f) =>
                      setAction({
                        endpoint: `/fees/assessments/${f.id}/void`,
                        title: 'Void transport installment',
                      })
                    }
                  />
                  {!statement.data.transport.length && (
                    <p className="text-sm text-stone-500">
                      No transport service assigned. Transport fees are not charged without an
                      assignment.
                    </p>
                  )}
                  {statement.data.transport.map((t) => (
                    <div
                      key={String(t.id)}
                      className="flex flex-wrap justify-between gap-3 rounded-xl border border-stone-200 bg-white p-4 text-sm"
                    >
                      <div>
                        <strong>{String(t.route_name)}</strong>
                        <p className="mt-1 text-stone-600">
                          {day(t.starts_on)} – {day(t.ended_on || t.ends_on)} ·{' '}
                          {feeAmount(t.amount)} · {String(t.frequency).replaceAll('_', ' ')}
                        </p>
                      </div>
                      {manage && !t.ended_on && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setAction({
                              endpoint: `/fees/transport/${t.id}/end`,
                              title: 'End student transport',
                              transport: true,
                            })
                          }
                        >
                          End service
                        </Button>
                      )}
                    </div>
                  ))}
                </section>
                <section className="space-y-3">
                  <h3 className="text-lg font-semibold">Payment history & receipts</h3>
                  {!statement.data.payments.length ? (
                    <p className="text-sm text-stone-500">No payments recorded.</p>
                  ) : (
                    <div className="space-y-3">
                      {statement.data.payments.map((p) => (
                        <article
                          key={p.id}
                          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-stone-200 bg-white p-4 text-sm"
                        >
                          <div className="min-w-0">
                            <strong className="block break-all">{p.receipt_no}</strong>
                            <p className="mt-1 text-stone-500">
                              {p.kind === 'OPENING'
                                ? 'Historical opening balance'
                                : day(p.payment_date)}{' '}
                              · {feeAmount(p.amount, p.currency)} ·{' '}
                              {p.payment_method.replaceAll('_', ' ')}
                            </p>
                            <p className="mt-1 text-xs text-stone-500">
                              Recorded by {p.recorded_by_label || 'Historical record'}
                              {p.reference ? ' · ' + p.reference : ''}
                            </p>
                            {p.reversed_at && (
                              <p className="mt-1 text-rose-700">Reversed: {p.reversal_reason}</p>
                            )}
                          </div>
                          <div className="flex gap-2">
                            <Button size="sm" variant="outline" onClick={() => setReceipt(p)}>
                              <Receipt size={14} />
                              Receipt
                            </Button>
                            {manage && !p.reversed_at && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  setAction({
                                    endpoint: `/fees/payments/${p.id}/reverse`,
                                    title: 'Reverse fee payment',
                                  })
                                }
                              >
                                Reverse
                              </Button>
                            )}
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              </>
            )
          )}
        </div>
      )}
      {tab === 'structures' && staff && (
        <section className="space-y-5">
          {!grade ? (
            <Empty
              title="Select a class"
              description="Fee structures are configured by class and academic year, with a shared or separate fee for its sections."
            />
          ) : structures.isLoading ? (
            <Loading />
          ) : structures.error ? (
            <ErrorState error={structures.error} retry={() => structures.refetch()} />
          ) : (
            <>
              <div className="flex flex-wrap justify-between gap-3">
                <h2 className="text-xl font-semibold">
                  Class {grade} · {session?.name}
                </h2>
                {manage && (
                  <Button variant="lime" onClick={() => setStructureOpen(true)}>
                    <Plus size={15} />
                    {latest ? 'Edit as new version' : 'Configure fees'}
                  </Button>
                )}
              </div>
              {latest ? (
                <>
                  <p className="notice">
                    Version {latest.version} ·{' '}
                    {latest.mode === 'SAME'
                      ? 'Same fee for all configured sections'
                      : 'Different fees by section'}{' '}
                    · {latest.class_ids?.length || 0} sections. Saving does not rewrite existing
                    student charges.
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {latest.items.map((i) => (
                      <article
                        key={i.id}
                        className="rounded-xl border border-stone-200 bg-white p-4 text-sm"
                      >
                        <h3 className="font-semibold">
                          {i.label} ·{' '}
                          {i.class_id
                            ? 'Section ' + sections.find((c) => c.id === i.class_id)?.section
                            : 'All sections'}
                        </h3>
                        <p className="mt-2">
                          {feeAmount(i.amount)} per installment · {i.frequency.replaceAll('_', ' ')}
                        </p>
                        <p className="mt-1 text-stone-500">
                          {i.category} · First due {day(i.first_due_on)}
                        </p>
                      </article>
                    ))}
                  </div>
                  {manage && (
                    <div className="rounded-xl border border-lime-200 bg-lime-50 p-4">
                      <p className="mb-3 text-sm">
                        Select a section above, optionally select a student, then preview and assess
                        installments. Existing matching charges are skipped.
                      </p>
                      <Button variant="lime" disabled={!selectedClass || busy} onClick={assessment}>
                        {busy ? 'Preparing…' : 'Preview & assess fees'}
                      </Button>
                    </div>
                  )}
                  <details className="rounded-xl border border-stone-200 p-4">
                    <summary className="cursor-pointer text-sm font-medium">
                      Previous versions
                    </summary>
                    {structures.data?.data.slice(1).map((st) => (
                      <div key={st.id} className="mt-3 border-t border-stone-200 pt-3 text-sm">
                        <h3 className="font-semibold">
                          Version {st.version} · {day(st.created_at)} ·{' '}
                          {st.mode === 'SAME' ? 'Same fee' : 'Section fees'}
                        </h3>
                        {st.items.map((i) => (
                          <p key={i.id}>
                            {i.label} · {feeAmount(i.amount)} · {i.frequency} ·{' '}
                            {day(i.first_due_on)}
                          </p>
                        ))}
                      </div>
                    ))}
                    {structures.data?.data.length === 1 && (
                      <p className="mt-3 text-sm text-stone-500">No previous versions.</p>
                    )}
                  </details>
                </>
              ) : (
                <Empty
                  title="No class fee structure"
                  description="Configure class fees once for all sections or set different fees for each section."
                />
              )}
            </>
          )}
        </section>
      )}
      {tab === 'transport' && staff && (
        <section className="space-y-4">
          <div className="flex flex-wrap justify-between gap-3">
            <h2 className="text-xl font-semibold">School transport routes</h2>
            {manage && (
              <Button variant="lime" onClick={() => setRouteEdit(null)}>
                <Plus size={15} />
                Add route
              </Button>
            )}
          </div>
          <p className="text-sm text-stone-600">
            Select a student under Student fees to assign their route, price, service dates and
            billing schedule.
          </p>
          {routes.isLoading ? (
            <Loading />
          ) : routes.error ? (
            <ErrorState error={routes.error} retry={() => routes.refetch()} />
          ) : (
            routes.data?.data.map((r) => (
              <article
                key={r.id}
                className="flex flex-wrap justify-between gap-3 rounded-xl border border-stone-200 bg-white p-5"
              >
                <div>
                  <h3 className="font-semibold">{r.name}</h3>
                  <p className="mt-1 text-sm text-stone-500">{r.description}</p>
                  <p className="mt-2 text-xs">
                    {r.active ? 'Active' : 'Unavailable for new assignments'}
                  </p>
                </div>
                {manage && (
                  <Button size="sm" variant="outline" onClick={() => setRouteEdit(r)}>
                    Edit route
                  </Button>
                )}
              </article>
            ))
          )}
          {routes.data?.data.length === 0 && (
            <Empty
              title="No transport routes"
              description="Add your school bus routes or transport services."
            />
          )}
        </section>
      )}
      {tab === 'reports' && staff && (
        <section className="space-y-5">
          <div className="grid items-end gap-3 sm:grid-cols-4">
            <label className="text-sm">
              Fee category
              <select
                className="input mt-2"
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  setReportPage(1);
                }}
              >
                <option value="">All categories</option>
                {['TUITION', 'ADMISSION', 'EXAMINATION', 'ANNUAL', 'OTHER', 'TRANSPORT'].map(
                  (c) => (
                    <option key={c}>{c}</option>
                  ),
                )}
              </select>
            </label>
            <label className="text-sm">
              Collection from
              <input
                className="input mt-2"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label className="text-sm">
              Collection to
              <input
                className="input mt-2"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
            <Button variant="outline" disabled={busy} onClick={download}>
              <Download size={15} />
              Export Excel / CSV
            </Button>
          </div>
          <p className="text-xs text-stone-500">
            Statement totals include all assessed installments in the selected academic year. Date
            filters apply to collections and the transaction export. CSV opens in Excel.
          </p>
          {report.isLoading ? (
            <Loading />
          ) : report.error ? (
            <ErrorState error={report.error} retry={() => report.refetch()} />
          ) : (
            report.data && (
              <>
                <FeeTotals rows={report.data.summary} />
                <h3 className="text-lg font-semibold">Date-wise verified collection</h3>
                {report.data.collections.length ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr>
                          {['Payment date', 'Category', 'Receipts', 'Net collected'].map((c) => (
                            <th className="p-3" key={c}>
                              {c}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {report.data.collections.map((c, n) => (
                          <tr key={n} className="border-t border-stone-200">
                            <td className="p-3">{c.payment_date}</td>
                            <td className="p-3">{c.category}</td>
                            <td className="p-3">{c.receipts}</td>
                            <td className="p-3">{feeAmount(c.collected, c.currency)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-sm text-stone-500">
                    No verified collections match these filters. Opening balances and reversed
                    payments are excluded.
                  </p>
                )}
                <h3 className="text-lg font-semibold">Student fee records</h3>
                <div className="space-y-2">
                  {report.data.records.data.map((f) => (
                    <button
                      key={f.id}
                      className="flex w-full flex-wrap justify-between gap-2 rounded-xl border border-stone-200 bg-white p-4 text-left text-sm hover:bg-lime-50"
                      onClick={() => {
                        setStudentId(f.student_id);
                        setTab('students');
                      }}
                    >
                      <span>
                        {f.student_label}
                        <span className="mt-1 block text-xs text-stone-500">
                          {f.class_label || 'Historical enrollment'} · {f.fee_type} ·{' '}
                          {day(f.due_on)}
                        </span>
                      </span>
                      <strong>
                        {feeAmount(
                          f.status === 'WAIVED' ? 0 : Number(f.amount_due) - Number(f.amount_paid),
                          f.currency,
                        )}{' '}
                        outstanding
                      </strong>
                    </button>
                  ))}
                </div>
                <Pagination
                  page={reportPage}
                  total={report.data.records.total}
                  pageSize={report.data.records.page_size}
                  onPage={setReportPage}
                />
              </>
            )
          )}
        </section>
      )}
      {structureOpen && session && (
        <FeeStructureForm
          year={year}
          grade={grade}
          classes={sections}
          latest={latest}
          start={day(session.starts_on)}
          close={() => setStructureOpen(false)}
        />
      )}
      {routeEdit !== undefined && (
        <RouteForm initial={routeEdit || undefined} close={() => setRouteEdit(undefined)} />
      )}
      {transportOpen && studentId && session && (
        <TransportForm
          studentId={studentId}
          year={year}
          start={day(session.starts_on)}
          end={day(session.ends_on)}
          routes={routes.data?.data || []}
          close={() => setTransportOpen(false)}
        />
      )}
      {payOpen && statement.data && (
        <CollectPayment
          fees={statement.data.assessments.filter(
            (f) =>
              !f.voided_at && f.status !== 'WAIVED' && Number(f.amount_due) > Number(f.amount_paid),
          )}
          studentId={studentId}
          year={year}
          close={() => setPayOpen(false)}
        />
      )}
      {receipt && (
        <FeeReceipt
          receipt={receipt.receipt_snapshot}
          payment={receipt}
          close={() => setReceipt(undefined)}
        />
      )}
      {action && <FeeReason {...action} close={() => setAction(undefined)} />}
    </>
  );
}
