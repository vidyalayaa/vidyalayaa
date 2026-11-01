import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, CalendarRange, CheckCircle2, Eye, Plus } from 'lucide-react';
import {
  promotionPlanSchema,
  prepareYearSchema,
  type PromotionWorkspace,
  type PromotionRun,
  type PromotionPlan,
  type PromotionPreview,
} from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { schoolPath } from '../../lib/portals';
import { scopedDraft } from '../../lib/drafts';
import { useUnsavedChanges } from '../../lib/use-unsaved-changes';
import { Button } from '../../components/ui/button';
import { PageHeading, Loading, ErrorState, Empty } from '../../components/common';
import { shiftDate } from '../calendar/calendar-utils';
import YearHistory from './YearHistory';
const outcomes = ['PROMOTE', 'REPEAT', 'GRADUATED', 'TRANSFERRED', 'WITHDRAWN'] as const;
const outcomeLabel = {
  PROMOTE: 'Promote',
  REPEAT: 'Repeat grade',
  GRADUATED: 'Graduate',
  TRANSFERRED: 'Transfer out',
  WITHDRAWN: 'Withdraw',
};
export default function AcademicYears() {
  const a = useAuth(),
    qc = useQueryClient(),
    [tab, setTab] = useState<'prepare' | 'history'>('prepare'),
    [selected, setSelected] = useState('');
  const q = useQuery({
    queryKey: [a.school, 'academic-year-promotion'],
    queryFn: () => api<PromotionWorkspace>('/promotion/workspace'),
    enabled: a.me?.school?.role === 'school_admin',
    staleTime: 0,
  });
  const run = q.data?.runs.find((r) => r.id === selected);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: [a.school] });
    await qc.invalidateQueries({ queryKey: ['me'] });
  };
  if (a.me?.school?.role !== 'school_admin')
    return (
      <Empty
        title="Access unavailable"
        description="Academic-year promotion belongs to School Admin."
      />
    );
  return (
    <>
      <PageHeading
        title="Academic years"
        description="Prepare the next year. Keep every learner’s history connected."
        actions={
          <Button asChild variant="outline">
            <Link to={schoolPath('/academics', 'school_admin')}>
              <ArrowLeft size={16} />
              Back to Academics
            </Link>
          </Button>
        }
      />
      <div className="mb-6 flex flex-wrap gap-3">
        <Button variant={tab === 'prepare' ? 'lime' : 'outline'} onClick={() => setTab('prepare')}>
          <CalendarRange size={17} />
          Start a new academic year
        </Button>
        <Button variant={tab === 'history' ? 'lime' : 'outline'} onClick={() => setTab('history')}>
          <Eye size={17} />
          View academic-year records
        </Button>
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : !q.data ? null : tab === 'history' ? (
        <YearHistory key={a.school} workspace={q.data} />
      ) : (
        <>
          <div className="mb-6 rounded-2xl border border-line bg-white p-5">
            <h2 className="text-lg font-semibold">
              Prepare → Map classes & students → Review & activate
            </h2>
            <p className="mt-2 text-sm leading-7 text-stone-600">
              Preparation copies configuration only. Students move and new fees are generated only
              after you preview and confirm activation. Accounts, parent links, receipts and
              historical balances stay connected.
            </p>
          </div>
          {!!q.data.runs.length && (
            <label className="mb-6 block max-w-2xl text-sm">
              Prepared and completed promotions
              <select
                className="input mt-2"
                aria-label="Prepared promotion"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
              >
                <option value="">Prepare another year</option>
                {q.data.runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {q.data!.years.find((y) => y.id === r.source_session_id)?.name} →{' '}
                    {q.data!.years.find((y) => y.id === r.target_session_id)?.name} ·{' '}
                    {r.status === 'COMPLETED' ? 'Completed' : 'Prepared'}
                  </option>
                ))}
              </select>
            </label>
          )}
          {run ? (
            <PromotionPlanner
              key={run.id}
              workspace={q.data}
              run={run}
              refresh={refresh}
              showHistory={() => setTab('history')}
            />
          ) : (
            <PrepareYear
              workspace={q.data}
              done={async (id) => {
                setSelected(id);
                await refresh();
              }}
            />
          )}
        </>
      )}
    </>
  );
}
function PrepareYear({
  workspace,
  done,
}: {
  workspace: PromotionWorkspace;
  done: (id: string) => Promise<void>;
}) {
  const a = useAuth(),
    timetableAvailable =
      !!a.me?.features.timetable && !!a.me?.school?.permissions.includes('timetable.write'),
    source = workspace.years.find((y) => y.is_current && !y.closed_at),
    [existing, setExisting] = useState(''),
    [name, setName] = useState(''),
    [starts, setStarts] = useState(source ? shiftDate(source.ends_on, 1) : ''),
    [ends, setEnds] = useState(source ? shiftDate(source.ends_on, 365) : ''),
    [teaching, setTeaching] = useState(true),
    [timetable, setTimetable] = useState(timetableAvailable),
    [fees, setFees] = useState(true),
    [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    attempt = useRef<{ body: string; key: string } | undefined>(undefined),
    busy = useRef(false);
  if (!source)
    return (
      <Empty
        title="Choose an initial current academic year"
        description="Set up the school’s first current year in Academic sessions before using promotion."
      />
    );
  return (
    <form
      className="space-y-6 rounded-2xl border border-line bg-white p-5 sm:p-7"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy.current) return;
        const parsed = prepareYearSchema.safeParse({
          source_session_id: source.id,
          ...(existing
            ? { target_session_id: existing }
            : { new_year: { name, starts_on: starts, ends_on: ends } }),
          copy_teaching: teaching,
          copy_timetable: timetable,
          copy_fees: fees,
        });
        if (!parsed.success) {
          setError(parsed.error.issues.map((i) => i.message).join(' '));
          return;
        }
        const body = JSON.stringify(parsed.data);
        if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
        busy.current = true;
        setPending(true);
        setError('');
        try {
          const run = await api<PromotionRun>('/promotion/prepare', {
            method: 'POST',
            headers: { 'Idempotency-Key': attempt.current!.key },
            body,
          });
          await done(run.id);
        } catch (cause) {
          setError((cause as Error).message);
        } finally {
          busy.current = false;
          setPending(false);
        }
      }}
    >
      <div>
        <h2 className="text-xl font-semibold">1. Prepare the new year</h2>
        <p className="mt-2 text-sm text-stone-600">
          Current year: <strong>{source.name}</strong> · {source.starts_on} – {source.ends_on}
        </p>
      </div>
      <label className="block text-sm">
        Target academic year
        <select
          className="input mt-2"
          aria-label="Target academic year"
          value={existing}
          disabled={pending}
          onChange={(e) => {
            setExisting(e.target.value);
            if (workspace.classes.some((c) => c.academic_session_id === e.target.value)) {
              setTeaching(false);
              setTimetable(false);
              setFees(false);
            }
          }}
        >
          <option value="">Create a new academic year</option>
          {workspace.years
            .filter(
              (y) =>
                !y.is_current &&
                !y.closed_at &&
                y.starts_on > source.ends_on &&
                !workspace.runs.some((r) => r.target_session_id === y.id),
            )
            .map((y) => (
              <option key={y.id} value={y.id}>
                {y.name} · {y.starts_on} – {y.ends_on}
              </option>
            ))}
        </select>
      </label>
      {!existing && (
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="text-sm">
            New year name
            <input
              className="input mt-2"
              aria-label="New year name"
              value={name}
              maxLength={100}
              required
              disabled={pending}
              placeholder="2027–2028"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="text-sm">
            Start date
            <input
              className="input mt-2"
              aria-label="New year start date"
              type="date"
              value={starts}
              min={shiftDate(source.ends_on, 1)}
              required
              disabled={pending}
              onChange={(e) => setStarts(e.target.value)}
            />
          </label>
          <label className="text-sm">
            End date
            <input
              className="input mt-2"
              aria-label="New year end date"
              type="date"
              value={ends}
              min={starts ? shiftDate(starts, 1) : undefined}
              required
              disabled={pending}
              onChange={(e) => setEnds(e.target.value)}
            />
          </label>
        </div>
      )}
      <fieldset className="space-y-4 rounded-xl bg-stone-50 p-5" disabled={pending}>
        <legend className="px-1 text-sm font-semibold">2. Carry forward configuration</legend>
        <p className="text-xs leading-6 text-stone-600">
          Classes and sections keep their designated Class Teachers. Existing target classes are
          kept as configured; turn copy options off for a year that already has classes. School-wide
          lecture timings stay unchanged.
        </p>
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-1 accent-lime-600"
            checked={teaching}
            onChange={(e) => {
              setTeaching(e.target.checked);
              if (!e.target.checked) setTimetable(false);
            }}
          />
          Copy subjects and subject-teacher assignments
        </label>
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-1 accent-lime-600"
            checked={timetable}
            disabled={!teaching || !timetableAvailable}
            onChange={(e) => setTimetable(e.target.checked)}
          />
          Copy class timetables
        </label>
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-1 accent-lime-600"
            checked={fees}
            onChange={(e) => setFees(e.target.checked)}
          />
          Copy fee structures to the new year, excluding admission charges
        </label>
        <p className="text-xs leading-6 text-stone-500">
          Copied fee dates are adjusted to the new year. You can review or revise the new-year
          structures in Fees before promotion. Preparation never charges students.
        </p>
      </fieldset>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      <Button variant="lime" disabled={pending}>
        <Plus size={16} />
        {pending ? 'Preparing…' : 'Prepare year'}
      </Button>
    </form>
  );
}
function PromotionPlanner({
  workspace,
  run,
  refresh,
  showHistory,
}: {
  workspace: PromotionWorkspace;
  run: PromotionRun;
  refresh: () => Promise<void>;
  showHistory: () => void;
}) {
  const a = useAuth();
  const q = useQuery({
    queryKey: [a.school, 'promotion-roster', run.id],
    queryFn: () => api<{ data: PromotionWorkspace['students'] }>(`/promotion/${run.id}/students`),
    enabled: run.status === 'PREPARED',
  });
  if (run.status === 'COMPLETED')
    return (
      <div className="rounded-2xl border border-lime-200 bg-lime-50 p-6">
        <CheckCircle2 className="mb-3 text-lime-800" />
        <h2 className="text-xl font-semibold">Academic year activated</h2>
        <p className="my-4 text-sm leading-7">
          Promotion is complete. Existing accounts and family links are retained. Previous-year
          records are closed; old balances and receipts remain in their original fee ledger.
        </p>
        <Button variant="outline" onClick={showHistory}>
          View year records
        </Button>
      </div>
    );
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  return (
    <PlanForm
      key={run.id}
      workspace={{ ...workspace, students: q.data?.data || [] }}
      run={run}
      refresh={refresh}
    />
  );
}
function PlanForm({
  workspace: w,
  run,
  refresh,
}: {
  workspace: PromotionWorkspace;
  run: PromotionRun;
  refresh: () => Promise<void>;
}) {
  const a = useAuth(),
    source = w.years.find((y) => y.id === run.source_session_id)!,
    target = w.years.find((y) => y.id === run.target_session_id)!,
    old = w.classes.filter((c) => c.academic_session_id === source.id),
    next = w.classes.filter((c) => c.academic_session_id === target.id);
  const draft = useMemo(
    () => scopedDraft(`vidyalayaa.draft.${a.me?.id}.${a.school}.promotion.${run.id}`),
    [a.me?.id, a.school, run.id],
  );
  const latestFee = (classId: string | null) =>
    w.structures.find(
      (s) => s.academic_session_id === target.id && s.class_ids.includes(classId || ''),
    )?.id || null;
  const [plan, setPlan] = useState<PromotionPlan>(() => {
      const restored = promotionPlanSchema.safeParse(draft.read().plan);
      if (restored.success && restored.data.promotion_id === run.id) return restored.data;
      return {
        promotion_id: run.id,
        activation_on: target.starts_on,
        generate_fees: true,
        roll_numbers: 'KEEP',
        exceptions: [],
        mappings: old.map((c) => {
          const grade = /^\d+$/.test(c.grade) ? String(Number(c.grade) + 1) : '';
          const dest = next.find((n) => n.grade === grade && n.section === c.section);
          return {
            source_class_id: c.id,
            target_class_id: dest?.id || null,
            fee_structure_id: latestFee(dest?.id || null),
            outcome: 'PROMOTE',
          };
        }),
      };
    }),
    [preview, setPreview] = useState<PromotionPreview>(),
    [search, setSearch] = useState(''),
    [page, setPage] = useState(1),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false),
    [confirmation, setConfirmation] = useState(''),
    [dirty, setDirty] = useState(false),
    busy = useRef(false);
  useUnsavedChanges(dirty);
  useEffect(() => {
    if (dirty && draft.isCurrent()) draft.save({ plan });
  }, [plan, draft, dirty]);
  const change = (nextPlan: PromotionPlan) => {
    setPlan(nextPlan);
    setDirty(true);
    setPreview(undefined);
    setConfirmation('');
    setError('');
  };
  const matches = w.students.filter((s) =>
      `${s.student_name} ${s.student_code} ${s.grade} ${s.section}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ),
    visible = matches.slice((page - 1) * 25, page * 25);
  const updateMapping = (index: number, patch: Partial<PromotionPlan['mappings'][number]>) =>
    change({
      ...plan,
      mappings: plan.mappings.map((m, i) => (i === index ? { ...m, ...patch } : m)),
    });
  const exception = (
    student: PromotionWorkspace['students'][number],
    patch: Partial<PromotionPlan['exceptions'][number]> | null,
  ) => {
    const current = plan.exceptions.find((e) => e.enrollment_id === student.id);
    change({
      ...plan,
      exceptions: [
        ...plan.exceptions.filter((e) => e.enrollment_id !== student.id),
        ...(patch
          ? [
              {
                enrollment_id: student.id,
                outcome: 'PROMOTE' as const,
                target_class_id:
                  plan.mappings.find((m) => m.source_class_id === student.class_id)
                    ?.target_class_id || null,
                roll_number: student.roll_number,
                reason: '',
                ...current,
                ...patch,
              },
            ]
          : []),
      ],
    });
  };
  async function review() {
    if (busy.current) return;
    const parsed = promotionPlanSchema.safeParse(plan);
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => i.path.join(' → ') + ': ' + i.message).join(' '));
      return;
    }
    busy.current = true;
    setPending(true);
    setError('');
    try {
      setPreview(
        await api<PromotionPreview>('/promotion/preview', {
          method: 'POST',
          body: JSON.stringify(parsed.data),
        }),
      );
      setConfirmation('');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-line bg-white p-5 sm:p-7">
        <h2 className="text-xl font-semibold">3. Map classes & sections</h2>
        <p className="mt-2 text-sm leading-7 text-stone-600">
          {source.name} → {target.name}. Students receive the destination class’s subjects,
          teachers, timetable and fee plan. Historical work is never moved into the new year.
        </p>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <label className="text-sm">
            Activation / enrollment date
            <input
              aria-label="Activation date"
              className="input mt-2"
              type="date"
              min={target.starts_on}
              max={target.ends_on}
              value={plan.activation_on}
              disabled={pending}
              onChange={(e) => change({ ...plan, activation_on: e.target.value })}
            />
          </label>
          <label className="text-sm">
            New roll numbers
            <select
              aria-label="Roll number handling"
              className="input mt-2"
              value={plan.roll_numbers}
              disabled={pending}
              onChange={(e) =>
                change({ ...plan, roll_numbers: e.target.value as 'KEEP' | 'RENUMBER' })
              }
            >
              <option value="KEEP">Keep current roll numbers</option>
              <option value="RENUMBER">Renumber within each destination section</option>
            </select>
          </label>
        </div>
        <div className="mt-6 space-y-4">
          {plan.mappings.map((m, index) => {
            const c = old.find((c) => c.id === m.source_class_id) || {
              id: m.source_class_id,
              grade: 'Unavailable',
              section: 'class',
            };
            return (
              <div
                key={c.id}
                className="grid items-start gap-4 rounded-xl border border-line p-4 sm:grid-cols-2 xl:grid-cols-4"
              >
                <div className="pt-2">
                  <h3 className="font-semibold">
                    Class {c.grade} · Section {c.section}
                  </h3>
                  <p className="mt-1 text-xs text-stone-500">
                    {w.students.filter((s) => s.class_id === c.id).length} active students
                  </p>
                </div>
                <label className="text-sm">
                  Class outcome
                  <select
                    className="input mt-2"
                    aria-label={`Class ${c.grade} ${c.section} outcome`}
                    value={m.outcome}
                    disabled={pending}
                    onChange={(e) => {
                      const outcome = e.target.value as typeof m.outcome;
                      const dest =
                        outcome === 'REPEAT'
                          ? next.find((n) => n.grade === c.grade && n.section === c.section)?.id ||
                            null
                          : ['PROMOTE', 'REPEAT'].includes(outcome)
                            ? m.target_class_id
                            : null;
                      updateMapping(index, {
                        outcome,
                        target_class_id: dest,
                        fee_structure_id: latestFee(dest),
                      });
                    }}
                  >
                    {outcomes.map((o) => (
                      <option key={o} value={o}>
                        {outcomeLabel[o]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  Destination class
                  <select
                    className="input mt-2"
                    aria-label={`Destination for Class ${c.grade} ${c.section}`}
                    value={m.target_class_id || ''}
                    disabled={pending || !['PROMOTE', 'REPEAT'].includes(m.outcome)}
                    onChange={(e) =>
                      updateMapping(index, {
                        target_class_id: e.target.value || null,
                        fee_structure_id: latestFee(e.target.value),
                      })
                    }
                  >
                    <option value="">Select destination</option>
                    {next.map((n) => (
                      <option key={n.id} value={n.id}>
                        Class {n.grade} · Section {n.section}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  New class fee structure
                  <select
                    className="input mt-2"
                    aria-label={`Fee plan for Class ${c.grade} ${c.section}`}
                    value={m.fee_structure_id || ''}
                    disabled={pending || !m.target_class_id || !plan.generate_fees}
                    onChange={(e) =>
                      updateMapping(index, { fee_structure_id: e.target.value || null })
                    }
                  >
                    <option value="">Choose a fee plan</option>
                    {w.structures
                      .filter(
                        (s) =>
                          s.academic_session_id === target.id &&
                          s.class_ids.includes(m.target_class_id || ''),
                      )
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          Grade {s.grade} · Version {s.version} · {s.items} items
                        </option>
                      ))}
                  </select>
                </label>
              </div>
            );
          })}
        </div>
      </section>
      <section className="rounded-2xl border border-line bg-white p-5 sm:p-7">
        <h2 className="text-xl font-semibold">4. Review student exceptions</h2>
        <p className="mt-2 text-sm leading-7 text-stone-600">
          Students use their class outcome unless you add an exception. Give a reason for individual
          changes. Graduates and leavers receive no new enrollment or fees; their outcome is
          recorded in this transition. Accounts, profiles and family links are retained.
        </p>
        <input
          className="input my-5 max-w-xl"
          aria-label="Find promotion student"
          placeholder="Find by name, student code or class"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <div className="space-y-4">
          {visible.map((s) => {
            const ex = plan.exceptions.find((e) => e.enrollment_id === s.id);
            return (
              <div key={s.id} className="rounded-xl border border-line p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">{s.student_name}</h3>
                    <p className="mt-1 text-xs text-stone-500">
                      {s.student_code} · Class {s.grade} {s.section} · Roll{' '}
                      {s.roll_number || 'not recorded'}
                    </p>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="accent-lime-600"
                      aria-label={`Override ${s.student_code}`}
                      checked={!!ex}
                      disabled={pending}
                      onChange={(e) => exception(s, e.target.checked ? {} : null)}
                    />
                    Individual exception
                  </label>
                </div>
                {ex && (
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <label className="text-sm">
                      Student outcome
                      <select
                        className="input mt-2"
                        aria-label={`Outcome for ${s.student_code}`}
                        value={ex.outcome}
                        disabled={pending}
                        onChange={(e) => {
                          const outcome = e.target.value as typeof ex.outcome;
                          const dest =
                            outcome === 'REPEAT'
                              ? next.find((n) => n.grade === s.grade && n.section === s.section)
                                  ?.id || null
                              : ['PROMOTE', 'REPEAT'].includes(outcome)
                                ? ex.target_class_id
                                : null;
                          exception(s, { outcome, target_class_id: dest });
                        }}
                      >
                        {outcomes.map((o) => (
                          <option key={o} value={o}>
                            {outcomeLabel[o]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-sm">
                      Destination
                      <select
                        className="input mt-2"
                        aria-label={`Destination for ${s.student_code}`}
                        value={ex.target_class_id || ''}
                        disabled={pending || !['PROMOTE', 'REPEAT'].includes(ex.outcome)}
                        onChange={(e) => exception(s, { target_class_id: e.target.value || null })}
                      >
                        <option value="">Select destination</option>
                        {next.map((c) => (
                          <option key={c.id} value={c.id}>
                            Class {c.grade} · Section {c.section}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-sm">
                      Roll number
                      <input
                        className="input mt-2"
                        aria-label={`Roll number for ${s.student_code}`}
                        value={ex.roll_number || ''}
                        maxLength={80}
                        disabled={pending || plan.roll_numbers === 'RENUMBER'}
                        onChange={(e) => exception(s, { roll_number: e.target.value || null })}
                      />
                    </label>
                    <label className="text-sm">
                      Reason
                      <input
                        className="input mt-2"
                        aria-label={`Reason for ${s.student_code}`}
                        value={ex.reason}
                        maxLength={500}
                        required
                        disabled={pending}
                        onChange={(e) => exception(s, { reason: e.target.value })}
                      />
                    </label>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-sm">
          <span>
            {matches.length} students · {plan.exceptions.length} exceptions · Page {page}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)}>
              Previous students
            </Button>
            <Button
              variant="outline"
              disabled={page * 25 >= matches.length}
              onClick={() => setPage(page + 1)}
            >
              Next students
            </Button>
          </div>
        </div>
      </section>
      <section className="rounded-2xl border border-line bg-white p-5 sm:p-7">
        <h2 className="text-xl font-semibold">5. Fees & final preview</h2>
        <label className="my-5 flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-1 accent-lime-600"
            checked={plan.generate_fees}
            disabled={pending}
            onChange={(e) => change({ ...plan, generate_fees: e.target.checked })}
          />
          Generate new-year installments from the destination class fee structures
        </label>
        <p className="mb-5 text-xs leading-6 text-stone-600">
          Old balances, payments and receipts are kept in the old ledger and are not charged again.
          Individual exceptions use the latest configured fee structure for their destination if
          that class is not mapped above; the exact amount is included in the preview. Configure
          missing structures in Fees, then refresh this page and review again.
        </p>
        <Button variant="lime" disabled={pending} onClick={review}>
          {pending ? 'Checking records…' : 'Preview promotion'}
          <ArrowRight size={16} />
        </Button>
      </section>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {preview && (
        <section
          className="space-y-5 rounded-2xl border border-line bg-white p-5 sm:p-7"
          aria-label="Promotion preview"
        >
          <h2 className="text-xl font-semibold">6. Review & confirm activation</h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Object.entries(preview.counts).map(([key, value]) => (
              <div key={key} className="rounded-xl bg-stone-50 p-4">
                <p className="text-xs capitalize text-stone-500">{key}</p>
                <p className="mt-2 text-2xl font-semibold">{value}</p>
              </div>
            ))}
          </div>
          <p className="text-sm">
            <strong>New fees:</strong> {preview.fees.currency} {preview.fees.amount} ·{' '}
            {preview.fees.installments} installments
          </p>
          <p className="text-sm">
            <strong>Existing unpaid balances retained:</strong>{' '}
            {preview.old_balances.map((b) => `${b.currency} ${b.balance}`).join(' · ') || 'None'}
          </p>
          {preview.warnings.length > 0 && (
            <ul className="list-disc space-y-2 rounded-xl bg-amber-50 p-5 pl-9 text-sm text-amber-950">
              {preview.warnings.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          )}
          {preview.blockers.length > 0 && (
            <div className="rounded-xl bg-red-50 p-5 text-sm text-red-900" role="alert">
              <h3 className="mb-3 font-semibold">Resolve before activation</h3>
              <ul className="list-disc space-y-2 pl-4">
                {preview.blockers.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
          )}
          <details className="rounded-xl border border-line p-4">
            <summary className="cursor-pointer text-sm font-semibold">
              Review {preview.students.length} individual student outcomes
            </summary>
            <div className="mt-4 max-h-96 overflow-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    {['Student', 'Previous class', 'New class', 'Outcome', 'Roll number'].map(
                      (h) => (
                        <th className="p-3" key={h}>
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {preview.students.map((s) => (
                    <tr className="border-t border-line" key={s.enrollment_id}>
                      <td className="p-3">{s.name}</td>
                      <td className="p-3">{s.from}</td>
                      <td className="p-3">{s.to}</td>
                      <td className="p-3">
                        {outcomeLabel[s.outcome as keyof typeof outcomeLabel]}
                      </td>
                      <td className="p-3">{s.roll_number || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <p className="text-sm leading-7 text-stone-600">
            Activating closes {source.name}, ends its enrollments and starts {target.name} on{' '}
            {preview.activation_on}. Teachers and timetables remain attached to their configured
            classes. All changes commit together. Confirmation expires after 15 minutes and must be
            reviewed again if records change.
          </p>
          <label className="block max-w-sm text-sm">
            Type ACTIVATE to confirm
            <input
              aria-label="Activation confirmation"
              className="input mt-2"
              value={confirmation}
              autoComplete="off"
              disabled={pending || !!preview.blockers.length}
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </label>
          <Button
            variant="lime"
            disabled={pending || !!preview.blockers.length || confirmation !== 'ACTIVATE'}
            onClick={async () => {
              if (busy.current) return;
              busy.current = true;
              setPending(true);
              setError('');
              try {
                await api('/promotion/activate', {
                  method: 'POST',
                  body: JSON.stringify({ plan, token: preview.token, confirmation }),
                });
                draft.clear();
                setDirty(false);
                await refresh();
              } catch (cause) {
                setError((cause as Error).message);
                setPreview(undefined);
                setConfirmation('');
              } finally {
                busy.current = false;
                setPending(false);
              }
            }}
          >
            {pending ? 'Activating…' : 'Confirm & activate academic year'}
          </Button>
        </section>
      )}
    </div>
  );
}
