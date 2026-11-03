import InviteMemberDialog from '../auth/InviteMemberDialog';
import SupportRequests from './SupportRequests';
import ClassAttendanceSheet from './ClassAttendanceSheet';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Plus,
  Download,
  ArrowUpRight,
  Wifi,
  Radio,
  ShieldCheck,
  Check,
  X,
  FileText,
  RefreshCw,
  Users,
} from 'lucide-react';
import {
  memberCategories,
  memberCategoryRoles,
  membershipStatuses,
  type MemberCategory,
  type MemberCounts,
  type Page,
} from '@vidyalayaa/contracts';
import { api, configured, useAuth, downloadReport } from '../../lib/auth';
import { Button } from '../../components/ui/button';
import {
  PageHeading,
  Panel,
  Empty,
  DataTable,
  Loading,
  ErrorState,
  Badge,
  AttendanceTabs,
} from '../../components/common';
import { schoolPath } from '../../lib/portals';
import { ActionDialog, type ActionField } from '../../components/ActionDialog';
import { Dialog } from '../../components/ui/dialog';
import MemberInvitations from '../auth/MemberInvitations';
import RecordSelect from '../../components/RecordSelect';
import { display, label } from '../../lib/utils';
import { useRows } from '../../lib/use-records';
import Pagination from '../../components/Pagination';
import DeviceConfiguration from './DeviceConfiguration';
import { useTeachingClasses } from '../../lib/use-teaching-classes';
function Pages({ query }: { query: ReturnType<typeof useRows> }) {
  return query.automatic ? (
    <Pagination
      total={query.data?.total}
      page={query.page}
      pageSize={query.data?.page_size}
      onPage={query.setPage}
      hasNext={query.hasNext}
    />
  ) : null;
}
function Rows({ query, columns }: { query: ReturnType<typeof useRows>; columns: string[] }) {
  return query.isLoading ? (
    <Loading />
  ) : query.error ? (
    <ErrorState error={query.error} retry={() => query.refetch()} />
  ) : query.data?.data.length ? (
    <>
      <DataTable rows={query.data.data} columns={columns} />
      <Pages query={query} />
    </>
  ) : (
    <Empty />
  );
}
export function Attendance() {
  const teaching = useTeachingClasses();
  const a = useAuth(),
    [date, setDate] = useState(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: a.me?.school?.timezone || 'Asia/Kolkata',
      }).format(new Date()),
    ),
    [page, setPage] = useState(1),
    [classId, setClassId] = useState(''),
    query = useRows(
      `/attendance?date=${date}&page=${page}${classId ? `&class_id=${classId}` : ''}`,
    ),
    [action, setAction] = useState(''),
    [batchOpen, setBatchOpen] = useState(false),
    [correction, setCorrection] = useState<Record<string, unknown> | null>(null);
  const teacher = a.me?.school?.role === 'teacher';
  const canManage = (id?: unknown) =>
    !teacher || !!teaching.data?.data.some((c) => c.is_class_teacher && (!id || c.id === id));
  const manualAllowed =
    a.me?.school?.permissions.includes('attendance.manual_write') && canManage(classId);
  return (
    <>
      <PageHeading
        title="Every school day counts."
        description="Arrivals, departures, and everything in between."
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to={schoolPath('/corrections', a.me?.school?.role)}>
                Corrections <ArrowUpRight size={15} />
              </Link>
            </Button>
            <Button variant="outline" disabled={!manualAllowed} onClick={() => setBatchOpen(true)}>
              <Users size={16} />
              Class Register
            </Button>
            <Button variant="lime" disabled={!manualAllowed} onClick={() => setAction('manual')}>
              <Plus size={16} />
              Mark attendance
            </Button>
          </>
        }
      />
      {teacher && (
        <p className="mb-4 text-sm text-stone-600">
          Subject teachers can view assigned classes. Only the designated Class Teacher can manually
          manage attendance.
        </p>
      )}
      <AttendanceTabs active="daily" />
      <Panel
        title="Daily register"
        subtitle="Attendance and movement are recorded separately."
        action={
          <input
            aria-label="Attendance date"
            className="input w-auto"
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setPage(1);
            }}
          />
        }
      >
        <div className="table-toolbar">
          <div className="w-full max-w-sm">
            <label className="field-label" htmlFor="attendance-class">
              Class
            </label>
            <RecordSelect
              name="class_id"
              id="attendance-class"
              endpoint="/resources/classes"
              value={classId}
              onChange={(v) => {
                setClassId(v);
                setPage(1);
              }}
              optional
              label="class"
            />
          </div>
        </div>
        {query.data?.data.length ? (
          <DataTable
            rows={query.data.data}
            columns={[
              'student_code',
              'first_name',
              'last_name',
              'attendance_status',
              'movement_status',
              'first_arrival_at',
              'last_departure_at',
              'needs_review',
            ]}
            actions={
              a.me?.school?.permissions.includes('attendance.correct_request')
                ? (row) =>
                    canManage(row.class_id) ? (
                      <Button size="sm" variant="outline" onClick={() => setCorrection(row)}>
                        Request correction
                      </Button>
                    ) : null
                : undefined
            }
          />
        ) : (
          <Rows query={query} columns={['student_code', 'attendance_status']} />
        )}
        <div className="pagination">
          <span>
            Page {page} · {query.data?.total || 0} records
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page === 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!query.data || page * query.data.page_size >= query.data.total}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      </Panel>
      <ActionDialog
        open={action === 'manual'}
        close={() => setAction('')}
        title="Mark classroom attendance"
        endpoint="/attendance/manual"
        fields={[
          {
            key: 'student_id',
            lookup: teacher ? '/resources/students?class_teacher=1' : '/resources/students',
          },
          { key: 'date', type: 'date', default: date },
          { key: 'status', options: ['PRESENT', 'LATE', 'HALF_DAY', 'ABSENT', 'EXCUSED'] },
          { key: 'reason', type: 'textarea' },
          { key: 'expected_version', type: 'number', optional: true },
        ]}
      />
      {correction && (
        <ActionDialog
          open
          close={() => setCorrection(null)}
          title={`Correct ${correction.first_name}'s attendance`}
          endpoint="/corrections"
          fields={[
            { key: 'daily_attendance_id', type: 'hidden', default: String(correction.id) },
            {
              key: 'requested_status',
              options: ['PRESENT', 'LATE', 'HALF_DAY', 'ABSENT', 'EXCUSED'],
              default: String(correction.attendance_status),
            },
            { key: 'reason', type: 'textarea' },
          ]}
        />
      )}
      {batchOpen && (
        <ClassAttendanceSheet
          open={batchOpen}
          close={() => {
            setBatchOpen(false);
            query.refetch();
          }}
          initialClassId={classId}
          initialDate={date}
        />
      )}
    </>
  );
}
export function Devices() {
  const a = useAuth(),
    query = useRows('/devices'),
    [claim, setClaim] = useState(false),
    [configuration, setConfiguration] = useState<Record<string, unknown> | null>(null),
    [edit, setEdit] = useState<Record<string, unknown> | null>(null);
  return (
    <>
      <PageHeading
        title="Your connected campus."
        description="A live view of the readers that keep your school in sync."
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/r/device_locations">
                Locations <ArrowUpRight size={15} />
              </Link>
            </Button>
            <Button
              variant="lime"
              onClick={() => setClaim(true)}
              disabled={!a.me?.school?.permissions.includes('devices.manage')}
            >
              <Plus size={16} />
              Claim device
            </Button>
          </>
        }
      />
      <div className="device-grid">
        {query.data?.data.map((d) => (
          <article className="device-card" key={String(d.id)}>
            <div className="flex items-center justify-between">
              <span className="device-card-icon">
                <Radio size={24} />
              </span>
              <Badge>
                {d.online ? 'ONLINE' : String(d.status) === 'ACTIVE' ? 'OFFLINE' : String(d.status)}
              </Badge>
            </div>
            <h2>{String(d.name)}</h2>
            <p>
              {String(d.device_code)} · {String(d.location_name || 'Location not assigned')}
            </p>
            <dl>
              <div>
                <dt>Last seen</dt>
                <dd>
                  {d.last_seen_at ? display(d.last_seen_at, a.me?.school?.timezone) : 'Never'}
                </dd>
              </div>
              <div>
                <dt>Pending events</dt>
                <dd>{String(d.pending_event_count)}</dd>
              </div>
              <div>
                <dt>Reader / clock</dt>
                <dd>
                  {String(d.reader_status)} / {String(d.rtc_status)}
                </dd>
              </div>
              <div>
                <dt>Firmware</dt>
                <dd>{String(d.firmware_version || 'Not reported')}</dd>
              </div>
            </dl>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setEdit(d)}
              disabled={!a.me?.school?.permissions.includes('devices.manage')}
            >
              Manage device <ArrowUpRight size={15} />
            </Button>
            {a.me?.school?.permissions.includes('devices.read') && (
              <Button
                className="mt-2 w-full"
                variant="outline"
                size="sm"
                onClick={() => setConfiguration(d)}
              >
                Reader settings & history
              </Button>
            )}
          </article>
        ))}
      </div>
      {query.data?.data.length ? <Pages query={query} /> : null}
      {!query.data?.data.length && (
        <Panel title="NFC devices">
          <Rows query={query} columns={['device_code', 'name', 'status']} />
        </Panel>
      )}
      <div className="notice">
        <ShieldCheck size={18} />
        Devices keep recording during connectivity outages. Uploads resume from the durable queue.
      </div>
      <ActionDialog
        open={claim}
        close={() => setClaim(false)}
        title="Claim an NFC reader"
        endpoint="/devices/claim"
        fields={[
          { key: 'device_code' },
          { key: 'claim_code', type: 'password' },
          { key: 'name' },
          { key: 'location_id', lookup: '/resources/device_locations' },
        ]}
      />
      {configuration && (
        <DeviceConfiguration device={configuration} close={() => setConfiguration(null)} />
      )}
      {edit && (
        <ActionDialog
          open={true}
          close={() => setEdit(null)}
          title={`Manage ${edit.name}`}
          endpoint={`/devices/${edit.id}`}
          method="PATCH"
          fields={[
            { key: 'name', default: String(edit.name) },
            {
              key: 'location_id',
              lookup: '/resources/device_locations',
              default: String(edit.location_id || ''),
            },
            {
              key: 'status',
              options: ['ACTIVE', 'DISABLED', 'REVOKED'],
              default: String(edit.status),
            },
            { key: 'reason', type: 'textarea' },
          ]}
        />
      )}
    </>
  );
}
export function Corrections() {
  const [params, setParams] = useSearchParams();
  const a = useAuth(),
    qc = useQueryClient(),
    status = params.get('status') || '',
    reviewable = params.get('reviewable') === '1',
    query = useRows('/corrections' + (params.toString() ? '?' + params.toString() : '')),
    [deciding, setDeciding] = useState(false),
    [error, setError] = useState('');
  function filter(key: string, value: string) {
    const next = new URLSearchParams(params);
    next.delete('page');
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  }
  async function decide(id: unknown, approve: boolean) {
    if (deciding) return;
    setDeciding(true);
    setError('');
    try {
      await api(`/corrections/${id}/decision`, {
        method: 'POST',
        body: JSON.stringify({ approve }),
      });
      await qc.invalidateQueries({ queryKey: [a.school] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeciding(false);
    }
  }
  return (
    <>
      <PageHeading
        title="Make every record right."
        description="A reason, a review, and a clear audit trail."
        actions={
          <Button
            variant="lime"
            asChild
            disabled={!a.me?.school?.permissions.includes('attendance.correct_request')}
          >
            <Link to="/attendance">
              <Plus size={16} />
              Request from daily register
            </Link>
          </Button>
        }
      />
      {error && (
        <div className="notice" role="alert">
          {error}
        </div>
      )}
      <Panel title="Correction requests">
        <div className="table-toolbar flex flex-wrap gap-4">
          <label className="text-sm">
            Status
            <select
              aria-label="Correction status"
              className="input mt-1"
              value={status}
              onChange={(e) => filter('status', e.target.value)}
            >
              <option value="">All statuses</option>
              {['REQUESTED', 'APPLIED', 'REJECTED', 'APPROVED', 'CANCELLED'].map((value) => (
                <option key={value} value={value}>
                  {label(value)}
                </option>
              ))}
            </select>
          </label>
          {a.me?.school?.permissions.includes('attendance.correct_approve') && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={reviewable}
                onChange={(e) => filter('reviewable', e.target.checked ? '1' : '')}
              />
              Requests from other people
            </label>
          )}
        </div>
        {query.data?.data.length ? (
          <div>
            {query.data.data.map((c) => (
              <div className="review-row" key={String(c.id)}>
                <div>
                  <h3>
                    {String(c.first_name)} {String(c.last_name || '')}{' '}
                    <Badge>{String(c.status)}</Badge>
                  </h3>
                  <p>{String(c.reason)}</p>
                  <small>
                    {String(c.student_code)} · {display(c.attendance_date, a.me?.school?.timezone)}{' '}
                    · Current: {label(String(c.current_status))} · Requested status:{' '}
                    {label(String(c.requested_status))}
                  </small>
                </div>
                {c.status === 'REQUESTED' && c.requested_by === a.me?.id && (
                  <p className="text-xs text-stone-600">
                    Another approver must review your request.
                  </p>
                )}
                {c.status === 'REQUESTED' &&
                  c.requested_by !== a.me?.id &&
                  a.me?.school?.permissions.includes('attendance.correct_approve') && (
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={deciding}
                        onClick={() => decide(c.id, false)}
                      >
                        <X size={14} />
                        Reject
                      </Button>
                      <Button
                        variant="lime"
                        size="sm"
                        disabled={deciding}
                        onClick={() => decide(c.id, true)}
                      >
                        <Check size={14} />
                        Approve
                      </Button>
                    </div>
                  )}
              </div>
            ))}
          </div>
        ) : (
          <Rows query={query} columns={['status']} />
        )}
        {!!query.data?.data.length && <Pages query={query} />}
      </Panel>
    </>
  );
}
export function Reports() {
  const a = useAuth(),
    query = useRows('/reports'),
    [open, setOpen] = useState(false),
    [kind, setKind] = useState('ATTENDANCE'),
    [error, setError] = useState('');
  async function download(id: unknown) {
    try {
      const r = await api<{ url: string }>(`/reports/${id}/download`);
      const row = query.data?.data.find((x) => x.id === id);
      await downloadReport(
        r.url,
        `vidyalayaa-report.${(row?.format || (row?.parameters as { format?: string })?.format) === 'CSV' ? 'csv' : 'pdf'}`,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <PageHeading
        title="Turn records into perspective."
        description="Secure, downloadable reports for the decisions ahead."
        actions={
          <Button variant="lime" disabled={!configured} onClick={() => setOpen(true)}>
            <Plus size={16} />
            Create report
          </Button>
        }
      />
      {error && (
        <div className="notice" role="alert">
          {error}
        </div>
      )}
      <div className="report-types">
        {[
          ['ATTENDANCE', 'Attendance', 'Daily presence and movement.'],
          ['ACADEMIC', 'Academic results', 'A clearer view of student progress.'],
          ['FEES', 'Fee collection', 'Charges, payments, and balances.'],
        ]
          .filter(
            (x) =>
              x[0] !== 'FEES' || a.me?.school?.permissions.includes('fees.read') || !configured,
          )
          .map(([kind, title, desc]) => (
            <article key={kind}>
              <span>
                <FileText size={23} />
              </span>
              <h2>{title}</h2>
              <p>{desc}</p>
              <Button
                variant="ghost"
                size="sm"
                disabled={!configured}
                onClick={() => {
                  setKind(kind);
                  setOpen(true);
                }}
              >
                Create report <ArrowUpRight size={14} />
              </Button>
            </article>
          ))}
      </div>
      <Panel
        title="Your reports"
        subtitle="Downloads are private and expire shortly after opening."
      >
        {query.data?.data.length ? (
          <div>
            {query.data.data.map((r) => (
              <div className="review-row" key={String(r.id)}>
                <div>
                  <h3>{String(r.kind)} report</h3>
                  <p>
                    {display(r.created_at, a.me?.school?.timezone)}{' '}
                    <Badge>{String(r.status)}</Badge>
                  </p>
                  {Boolean(r.error_code) && <p className="field-error">{String(r.error_code)}</p>}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={r.status !== 'COMPLETED'}
                  onClick={() => download(r.id)}
                >
                  <Download size={15} />
                  Download{' '}
                  {(r.format || (r.parameters as { format?: string })?.format) === 'CSV'
                    ? 'CSV'
                    : 'PDF'}
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <Rows query={query} columns={['kind', 'status']} />
        )}
        {!!query.data?.data.length && <Pages query={query} />}
      </Panel>
      <ActionDialog
        open={open}
        close={() => setOpen(false)}
        title="Create a school report"
        endpoint="/reports"
        fields={[
          {
            key: 'kind',
            default: kind,
            options: [
              'ATTENDANCE',
              'ACADEMIC',
              ...(a.me?.school?.permissions.includes('fees.read') ? ['FEES'] : []),
            ],
          },
          {
            key: 'student_id',
            lookup: '/resources/students',
            optional: !['parent', 'student'].includes(a.me?.school?.role || ''),
          },
          ...(!['parent', 'student'].includes(a.me?.school?.role || '')
            ? [{ key: 'class_id', optional: true, lookup: '/resources/classes' }]
            : []),
          {
            key: 'format',
            options: a.me?.features.advanced_reporting ? ['PDF', 'CSV'] : ['PDF'],
            default: 'PDF',
          },
          { key: 'from', type: 'date' },
          { key: 'to', type: 'date' },
        ]}
      />
    </>
  );
}
export function Notifications() {
  const [retry, setRetry] = useState<Record<string, unknown> | null>(null);
  const a = useAuth(),
    query = useRows('/notifications');
  return (
    <>
      <PageHeading
        title="Always in the loop."
        description="School updates and their delivery history."
        actions={
          a.me?.school?.role === 'parent' && (
            <Button variant="outline" asChild>
              <Link to="/r/notification_preferences">Preferences</Link>
            </Button>
          )
        }
      />
      {retry && (
        <ActionDialog
          open
          close={() => setRetry(null)}
          title="Retry failed delivery"
          endpoint={`/notifications/${retry.id}/retry`}
          fields={[{ key: 'reason', type: 'textarea' }]}
        />
      )}
      <Panel title="Notification history">
        {query.data?.data.length ? (
          query.data.data.map((n) => (
            <article key={String(n.id)} className="review-row">
              <div>
                <h3>{label(String(n.kind))}</h3>
                {Boolean(n.payload) && typeof n.payload === 'object' && (
                  <dl className="mt-2 space-y-1">
                    {Object.entries(n.payload as Record<string, unknown>)
                      .filter(([key]) => !key.endsWith('_id'))
                      .map(([key, value]) => (
                        <div key={key}>
                          <dt className="inline text-xs text-stone-500">{label(key)}: </dt>
                          <dd className="inline text-sm">
                            {display(value, a.me?.school?.timezone)}
                          </dd>
                        </div>
                      ))}
                  </dl>
                )}
                <p>
                  {display(n.created_at, a.me?.school?.timezone)} · {label(String(n.channel))}
                </p>
                {Boolean(n.last_error) && <p className="field-error">{String(n.last_error)}</p>}
              </div>
              <div className="flex gap-3">
                <Badge>{String(n.status)}</Badge>
                {a.me?.school?.permissions.includes('users.manage') &&
                  ['DEAD', 'FAILED'].includes(String(n.status)) && (
                    <Button size="sm" variant="outline" onClick={() => setRetry(n)}>
                      Retry delivery
                    </Button>
                  )}
              </div>
            </article>
          ))
        ) : (
          <Rows query={query} columns={['kind', 'status']} />
        )}
        {!!query.data?.data.length && <Pages query={query} />}
      </Panel>
    </>
  );
}
const memberCategoryLabels: Record<MemberCategory, string> = {
  staff: 'School Staff',
  parents: 'Parents',
  students: 'Students',
};

export function Members() {
  const auth = useAuth();
  const [category, setCategory] = useState<MemberCategory>('staff');
  const [inviteOpen, setInviteOpen] = useState(false);
  const counts = useQuery({
    queryKey: [auth.school, 'membership-counts'],
    queryFn: () => api<MemberCounts>('/memberships/counts'),
    enabled: configured && !!auth.me?.school,
    refetchInterval: 30000,
  });
  return (
    <>
      <PageHeading
        title="Members & invitations"
        description="Manage school access for staff, parents, and students."
        actions={
          <Button variant="lime" disabled={!configured} onClick={() => setInviteOpen(true)}>
            <Plus size={16} />
            Invite member
          </Button>
        }
      />
      <div role="tablist" aria-label="Member categories" className="mb-5 flex flex-wrap gap-2">
        {memberCategories.map((value, index) => (
          <button
            type="button"
            key={value}
            id={`members-tab-${value}`}
            role="tab"
            aria-selected={category === value}
            aria-controls="members-category"
            tabIndex={category === value ? 0 : -1}
            onClick={() => setCategory(value)}
            onKeyDown={(event) => {
              const last = memberCategories.length - 1;
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? last
                    : event.key === 'ArrowRight'
                      ? (index + 1) % (last + 1)
                      : event.key === 'ArrowLeft'
                        ? (index + last) % (last + 1)
                        : null;
              if (next === null) return;
              event.preventDefault();
              const tab = memberCategories[next];
              setCategory(tab);
              document.getElementById(`members-tab-${tab}`)?.focus();
            }}
            className={`flex items-center gap-2 rounded-xl border border-line px-4 py-2 text-sm font-semibold ${category === value ? 'bg-lime-300 text-stone-950' : 'bg-white text-stone-600 hover:bg-stone-50'}`}
          >
            {memberCategoryLabels[value]}
            <Badge>{counts.data?.[value] ?? '—'}</Badge>
          </button>
        ))}
      </div>
      {counts.error && <ErrorState error={counts.error} retry={() => counts.refetch()} />}
      <div role="tabpanel" id="members-category" aria-labelledby={`members-tab-${category}`}>
        <MemberCategoryPanel
          key={category}
          category={category}
          inviteOpen={inviteOpen}
          closeInvite={() => setInviteOpen(false)}
        />
      </div>
    </>
  );
}

function MemberCategoryPanel({
  category,
  inviteOpen,
  closeInvite,
}: {
  category: MemberCategory;
  inviteOpen: boolean;
  closeInvite: () => void;
}) {
  const [search, setSearch] = useState(''),
    [role, setRole] = useState(''),
    [status, setStatus] = useState(''),
    [invitationMessage, setInvitationMessage] = useState(''),
    [view, setView] = useState<Record<string, unknown> | null>(null),
    [edit, setEdit] = useState<Record<string, unknown> | null>(null);
  const filters = new URLSearchParams({ category });
  if (search.trim()) filters.set('search', search.trim());
  if (role) filters.set('role', role);
  const query = useRows(`/memberships?${filters}${status ? `&status=${status}` : ''}`);
  const name = memberCategoryLabels[category];
  return (
    <>
      <Panel
        title={`${name} memberships`}
        subtitle="Includes invited, active, suspended, and removed membership records."
      >
        <div className="grid gap-3 px-5 pb-4 sm:grid-cols-2 lg:grid-cols-3">
          <label>
            <span className="field-label">Search {name.toLowerCase()}</span>
            <input
              className="input"
              type="search"
              placeholder="Name or email"
              maxLength={120}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          {category === 'staff' && (
            <div>
              <label className="field-label" htmlFor="members-staff-role">Staff role</label>
              <select
                id="members-staff-role"
                className="input"
                value={role}
                onChange={(event) => setRole(event.target.value)}
              >
                <option value="">All staff roles</option>
                {memberCategoryRoles.staff.map((value) => (
                  <option key={value} value={value}>
                    {label(value)}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="field-label" htmlFor="members-status">Membership status</label>
            <select
              id="members-status"
              className="input"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="">All membership statuses</option>
              {membershipStatuses.map((value) => (
                <option key={value} value={value}>
                  {label(value.toLowerCase())}
                </option>
              ))}
            </select>
          </div>
        </div>
        {query.data?.data.length ? (
          <DataTable
            rows={query.data.data}
            columns={['full_name', 'email', 'role', 'status']}
            onView={setView}
            actions={(row) =>
              row.status === 'INVITED' ? (
                <span className="text-xs text-stone-600">Awaiting acceptance</span>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setEdit(row)}>
                  Edit membership
                </Button>
              )
            }
          />
        ) : query.isLoading || query.error ? (
          <Rows query={query} columns={['full_name', 'email', 'role', 'status']} />
        ) : (
          <Empty
            title="No matching memberships"
            description="Try a different name, email, or status."
          />
        )}
        {!!query.data?.data.length && <Pages query={query} />}
      </Panel>
      {invitationMessage && (
        <p className="notice" role="status">
          {invitationMessage}
        </p>
      )}
      <MemberInvitations filters={filters.toString()} />
      {inviteOpen && (
        <InviteMemberDialog
          category={category}
          close={closeInvite}
          onResult={(result) =>
            setInvitationMessage(
              result.status === 'READY'
                ? 'The person can sign in and accept the invitation. Their existing school record will be linked automatically.'
                : result.email_sent === false
                  ? 'This invitation is already pending. No additional email was sent.'
                  : 'The setup email has been sent. Acceptance will link the account to the selected school record.',
            )
          }
        />
      )}
      {view && (
        <Dialog
          open
          onOpenChange={(value) => !value && setView(null)}
          title="Member details"
          description={name}
        >
          <dl className="grid gap-4 sm:grid-cols-2">
            {['full_name', 'email', 'role', 'status'].map((field) => (
              <div key={field}>
                <dt className="field-label">{label(field)}</dt>
                <dd className="break-words">
                  {field === 'role' ? label(String(view[field])) : display(view[field])}
                </dd>
              </div>
            ))}
          </dl>
        </Dialog>
      )}
      {edit && (
        <ActionDialog
          open={true}
          close={() => setEdit(null)}
          title="Update membership"
          endpoint={`/memberships/${edit.id}`}
          method="PATCH"
          fields={[
            {
              key: 'role',
              options: [
                'school_admin',
                'principal',
                'teacher',
                'parent',
                'student',
                'finance_staff',
              ],
              default: String(edit.role),
            },
            {
              key: 'status',
              options: ['ACTIVE', 'SUSPENDED', 'REMOVED'],
              default: String(edit.status),
            },
          ]}
        />
      )}
    </>
  );
}
export function Audit() {
  const query = useRows('/audit');
  return (
    <>
      <PageHeading
        title="A record you can rely on."
        description="Append-only history of important school activity."
      />
      <Panel title="Audit history">
        <Rows
          query={query}
          columns={['occurred_at', 'actor_type', 'action', 'entity_type', 'entity_id']}
        />
      </Panel>
    </>
  );
}
export function SupportGrants() {
  const a = useAuth(),
    qc = useQueryClient(),
    q = useRows('/support-grants'),
    [error, setError] = useState('');
  async function decide(id: unknown, approve: boolean) {
    try {
      await api(`/support-grants/${id}/decision`, {
        method: 'POST',
        body: JSON.stringify({ approve }),
      });
      qc.invalidateQueries({ queryKey: [a.school] });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <PageHeading
        title="Support, with your permission."
        description="Review and revoke time-limited support access to school records."
      />
      {error && <div className="notice">{error}</div>}
      <SupportRequests />
      <Panel title="Support access requests">
        {q.data?.data.length ? (
          q.data.data.map((g) => (
            <div className="review-row" key={String(g.id)}>
              <div>
                <h3>{String(g.ticket_ref)}</h3>
                <p>{String(g.reason)}</p>
                <small>
                  Expires {display(g.expires_at, a.me?.school?.timezone)} ·{' '}
                  {g.revoked_at ? 'Revoked' : g.approved_by ? 'Approved' : 'Awaiting approval'}
                </small>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => decide(g.id, false)}>
                  Revoke
                </Button>
                {!g.approved_by && !g.revoked_at && (
                  <Button variant="lime" size="sm" onClick={() => decide(g.id, true)}>
                    Approve
                  </Button>
                )}
              </div>
            </div>
          ))
        ) : (
          <Rows query={q} columns={['reason']} />
        )}
        {!!q.data?.data.length && <Pages query={q} />}
      </Panel>
    </>
  );
}
