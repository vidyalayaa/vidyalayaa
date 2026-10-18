import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
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
} from 'lucide-react';
import type { Page } from '@vidyalayaa/contracts';
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
} from '../../components/common';
import { ActionDialog, type ActionField } from '../../components/ActionDialog';
import { Dialog } from '../../components/ui/dialog';
function useRows(endpoint: string) {
  const a = useAuth();
  return useQuery({
    queryKey: [a.school, endpoint],
    queryFn: () => api<Page>(endpoint),
    enabled: configured && !!a.me?.school,
    refetchInterval: endpoint === '/reports' ? 10000 : 30000,
  });
}
function Rows({ query, columns }: { query: ReturnType<typeof useRows>; columns: string[] }) {
  return query.isLoading ? (
    <Loading />
  ) : query.error ? (
    <ErrorState error={query.error} retry={() => query.refetch()} />
  ) : query.data?.data.length ? (
    <DataTable rows={query.data.data} columns={columns} />
  ) : (
    <Empty />
  );
}
export function Attendance() {
  const a = useAuth(),
    [date, setDate] = useState(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: a.me?.school?.timezone || 'Asia/Kolkata',
      }).format(new Date()),
    ),
    query = useRows(`/attendance?date=${date}`),
    [action, setAction] = useState('');
  return (
    <>
      <PageHeading
        title="Every school day counts."
        description="Arrivals, departures, and everything in between."
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/corrections">
                Corrections <ArrowUpRight size={15} />
              </Link>
            </Button>
            <Button
              variant="lime"
              disabled={!a.me?.school?.permissions.includes('attendance.manual_write')}
              onClick={() => setAction('manual')}
            >
              <Plus size={16} />
              Mark attendance
            </Button>
          </>
        }
      />
      <div className="tabs">
        <Link className="tab-active" to="/attendance">
          Daily attendance
        </Link>
        <Link to="/r/nfc_cards">NFC cards</Link>
        <Link to="/r/attendance_rule_versions">Rule versions</Link>
        <Link to="/r/school_holidays">Calendar</Link>
      </div>
      <Panel
        title="Daily register"
        subtitle="Attendance and movement are recorded separately."
        action={
          <input
            aria-label="Attendance date"
            className="input w-auto"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        }
      >
        <Rows
          query={query}
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
        />
      </Panel>
      <ActionDialog
        open={action === 'manual'}
        close={() => setAction('')}
        title="Mark classroom attendance"
        endpoint="/attendance/manual"
        fields={[
          { key: 'student_id' },
          { key: 'date', type: 'date', default: date },
          { key: 'status', options: ['PRESENT', 'LATE', 'HALF_DAY', 'ABSENT', 'EXCUSED'] },
          { key: 'reason', type: 'textarea' },
          { key: 'expected_version', type: 'number', optional: true },
        ]}
      />
    </>
  );
}
export function Devices() {
  const a = useAuth(),
    query = useRows('/devices'),
    [claim, setClaim] = useState(false),
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
                  {d.last_seen_at ? new Date(String(d.last_seen_at)).toLocaleString() : 'Never'}
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
          </article>
        ))}
      </div>
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
          { key: 'location_id' },
        ]}
      />
      {edit && (
        <ActionDialog
          open={true}
          close={() => setEdit(null)}
          title={`Manage ${edit.name}`}
          endpoint={`/devices/${edit.id}`}
          method="PATCH"
          fields={[
            { key: 'name', default: String(edit.name) },
            { key: 'location_id', default: String(edit.location_id || '') },
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
  const a = useAuth(),
    qc = useQueryClient(),
    query = useRows('/corrections'),
    [open, setOpen] = useState(false),
    [error, setError] = useState('');
  async function decide(id: unknown, approve: boolean) {
    try {
      await api(`/corrections/${id}/decision`, {
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
        title="Make every record right."
        description="A reason, a review, and a clear audit trail."
        actions={
          <Button
            variant="lime"
            onClick={() => setOpen(true)}
            disabled={!a.me?.school?.permissions.includes('attendance.correct_request')}
          >
            <Plus size={16} />
            Request correction
          </Button>
        }
      />
      {error && (
        <div className="notice" role="alert">
          {error}
        </div>
      )}
      <Panel title="Correction requests">
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
                  <small>Requested status: {String(c.requested_status)}</small>
                </div>
                {c.status === 'REQUESTED' &&
                  a.me?.school?.permissions.includes('attendance.correct_approve') && (
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => decide(c.id, false)}>
                        <X size={14} />
                        Reject
                      </Button>
                      <Button variant="lime" size="sm" onClick={() => decide(c.id, true)}>
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
      </Panel>
      <ActionDialog
        open={open}
        close={() => setOpen(false)}
        title="Request attendance correction"
        endpoint="/corrections"
        fields={[
          { key: 'daily_attendance_id' },
          {
            key: 'requested_status',
            options: ['PRESENT', 'LATE', 'HALF_DAY', 'ABSENT', 'EXCUSED'],
          },
          { key: 'reason', type: 'textarea' },
        ]}
      />
    </>
  );
}
export function Reports() {
  const a = useAuth(),
    query = useRows('/reports'),
    [open, setOpen] = useState(false),
    [error, setError] = useState('');
  async function download(id: unknown) {
    try {
      const r = await api<{ url: string }>(`/reports/${id}/download`);
      await downloadReport(r.url);
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
                onClick={() => setOpen(true)}
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
                    {new Date(String(r.created_at)).toLocaleString()}{' '}
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
                  Download PDF
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <Rows query={query} columns={['kind', 'status']} />
        )}
      </Panel>
      <ActionDialog
        open={open}
        close={() => setOpen(false)}
        title="Create a school report"
        endpoint="/reports"
        fields={[
          {
            key: 'kind',
            options: [
              'ATTENDANCE',
              'ACADEMIC',
              ...(a.me?.school?.permissions.includes('fees.read') ? ['FEES'] : []),
            ],
          },
          {
            key: 'student_id',
            optional: !['parent', 'student'].includes(a.me?.school?.role || ''),
          },
          { key: 'class_id', optional: true },
          { key: 'from', type: 'date' },
          { key: 'to', type: 'date' },
        ]}
      />
    </>
  );
}
export function Notifications() {
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
      <Panel title="Notification history">
        <Rows
          query={query}
          columns={['kind', 'channel', 'status', 'created_at', 'sent_at', 'last_error']}
        />
      </Panel>
    </>
  );
}
export function Members() {
  const a = useAuth(),
    query = useRows('/memberships'),
    [open, setOpen] = useState(false),
    [edit, setEdit] = useState<Record<string, unknown> | null>(null);
  return (
    <>
      <PageHeading
        title="A community, connected."
        description="Invite accounts and manage school memberships."
        actions={
          <Button variant="lime" disabled={!configured} onClick={() => setOpen(true)}>
            <Plus size={16} />
            Invite member
          </Button>
        }
      />
      <Panel title="School memberships">
        {query.data?.data.length ? (
          <DataTable
            rows={query.data.data}
            columns={['full_name', 'email', 'role', 'status']}
            onEdit={setEdit}
          />
        ) : (
          <Rows query={query} columns={['full_name', 'email', 'role', 'status']} />
        )}
      </Panel>
      <ActionDialog
        open={open}
        close={() => setOpen(false)}
        title="Invite a school member"
        endpoint="/invitations"
        fields={[
          { key: 'full_name' },
          { key: 'email', type: 'email' },
          { key: 'role', options: ['school_admin', 'principal', 'teacher', 'parent', 'student'] },
        ]}
      />
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
              options: ['school_admin', 'principal', 'teacher', 'parent', 'student'],
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
      <Panel title="Support access requests">
        {q.data?.data.length ? (
          q.data.data.map((g) => (
            <div className="review-row" key={String(g.id)}>
              <div>
                <h3>{String(g.ticket_ref)}</h3>
                <p>{String(g.reason)}</p>
                <small>
                  Expires {new Date(String(g.expires_at)).toLocaleString()} ·{' '}
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
      </Panel>
    </>
  );
}
