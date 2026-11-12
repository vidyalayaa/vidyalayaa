import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Send, Settings2 } from 'lucide-react';
import {
  customNotificationSchema,
  notificationRoles,
  schoolNotificationKinds,
  type NotificationMember,
  type NotificationPreview,
  type SchoolNotificationSettings,
} from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { enablePush, disablePush } from '../../lib/push';
import { label, display } from '../../lib/utils';
import { PageHeading, Panel, Badge, Loading, ErrorState } from '../../components/common';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';

type Page<T> = { data: T[]; total: number; page: number; page_size: number };
interface Notice {
  id: string;
  kind: string;
  status: string;
  created_at: string;
  sent_at?: string;
  last_error?: string;
  cancelled_at?: string;
  payload: { title?: string; body?: string };
  recipients?: number;
  accepted?: number;
  failed?: number;
  channel?: string;
  full_name?: string;
  email?: string;
}
const input = 'w-full rounded-xl border border-line bg-surface px-3 py-3 text-sm';
export default function Notifications() {
  const a = useAuth();
  return <SchoolNotifications key={a.school} />;
}
function SchoolNotifications() {
  const a = useAuth(),
    qc = useQueryClient(),
    manage = !!a.me?.school?.permissions.includes('notifications.manage'),
    history = ['school_admin', 'principal'].includes(a.me?.school?.role || '');
  const [tab, setTab] = useState('inbox'),
    [error, setError] = useState(''),
    [success, setSuccess] = useState(''),
    [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(''),
    [body, setBody] = useState(''),
    [audience, setAudience] = useState<'ALL' | 'ROLES' | 'MEMBERS'>('MEMBERS'),
    [roles, setRoles] = useState<string[]>([]),
    [ids, setIds] = useState<string[]>([]),
    [search, setSearch] = useState(''),
    [memberPage, setMemberPage] = useState(1);
  const [preview, setPreview] = useState<NotificationPreview | null>(null),
    [sendKey, setSendKey] = useState(''),
    [page, setPage] = useState(1),
    [kind, setKind] = useState(''),
    [status, setStatus] = useState(''),
    [details, setDetails] = useState<string | null>(null);
  const [action, setAction] = useState<{ path: string; title: string } | null>(null),
    [reason, setReason] = useState(''),
    [draft, setDraft] = useState<SchoolNotificationSettings | null>(null);
  const members = useQuery({
    queryKey: [a.school, 'notification-members', search, memberPage],
    queryFn: () =>
      api<Page<NotificationMember>>(
        `/notifications/members?search=${encodeURIComponent(search)}&page=${memberPage}&page_size=25`,
      ),
    enabled: manage && tab === 'compose' && audience === 'MEMBERS',
  });
  const settings = useQuery({
    queryKey: [a.school, 'notification-settings'],
    queryFn: () => api<SchoolNotificationSettings>('/notifications/settings'),
    enabled: manage && tab === 'settings',
  });
  const messages = useQuery({
    queryKey: [a.school, 'notification-history', page, kind, status],
    queryFn: () =>
      api<Page<Notice>>(`/notifications/messages?page=${page}&kind=${kind}&status=${status}`),
    enabled: history && tab === 'history',
    refetchInterval: 15000,
  });
  const inbox = useQuery({
    queryKey: [a.school, 'notification-inbox', page],
    queryFn: () => api<Page<Notice>>(`/notifications?page=${page}`),
    enabled: tab === 'inbox',
    refetchInterval: 30000,
  });
  const deliveries = useQuery({
    queryKey: [a.school, 'notification-deliveries', details, page],
    queryFn: () => api<Page<Notice>>(`/notifications/messages/${details}/deliveries?page=${page}`),
    enabled: !!details && tab === 'history',
    refetchInterval: 15000,
  });
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  }
  const invalidate = () =>
    qc.invalidateQueries({
      predicate: (q) =>
        q.queryKey[0] === a.school && String(q.queryKey[1]).startsWith('notification-'),
    });
  const config = draft || settings.data;
  const list = details && tab === 'history' ? deliveries : tab === 'history' ? messages : inbox;
  return (
    <>
      <PageHeading
        title="Notifications"
        description={
          manage
            ? 'Reach your school community and manage school alerts.'
            : 'Updates from your school, all in one place.'
        }
      />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-line bg-surface p-5">
        <div className="flex items-start gap-3">
          <Bell size={22} />
          <div>
            <h2 className="font-semibold">Notifications on this device</h2>
            <p className="mt-1 text-sm text-stone-600">
              Allow browser notifications to receive school messages through Firebase.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await enablePush();
                setSuccess('Browser notifications enabled for this school.');
                await invalidate();
              })
            }
          >
            Enable notifications
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await disablePush();
                setSuccess('Notifications disabled on this device.');
              })
            }
          >
            Disable on this device
          </Button>
        </div>
      </div>
      <div className="mb-6 flex flex-wrap gap-2" role="group" aria-label="Notification views">
        {[
          ['inbox', 'My notifications'],
          ...(manage ? [['compose', 'Send notification']] : []),
          ...(history ? [['history', 'School history']] : []),
          ...(manage ? [['settings', 'Automatic alerts']] : []),
        ].map(([key, name]) => (
          <Button
            key={key}
            variant={tab === key ? 'lime' : 'outline'}
            onClick={() => {
              setTab(key);
              setPage(1);
              setDetails(null);
              setError('');
            }}
          >
            {name}
          </Button>
        ))}
      </div>
      {error && (
        <p role="alert" className="field-error mb-4">
          {error}
        </p>
      )}
      {success && (
        <p role="status" className="notice mb-4">
          {success}
        </p>
      )}
      {tab === 'compose' && manage && (
        <Panel
          title="A message for your community"
          subtitle="Select active school accounts. No contact information leaves your school."
        >
          <form
            className="space-y-5 p-5"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const b = customNotificationSchema.parse({
                  title,
                  body,
                  audience,
                  roles,
                  user_ids: ids,
                });
                const p = await api<NotificationPreview>('/notifications/preview', {
                  method: 'POST',
                  body: JSON.stringify(b),
                });
                setPreview(p);
                setSendKey(crypto.randomUUID());
              });
            }}
          >
            <label className="block text-sm">
              Title
              <input
                className={input + ' mt-2'}
                required
                maxLength={120}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              Message
              <textarea
                className={input + ' mt-2 min-h-32'}
                required
                maxLength={1000}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              Send to
              <select
                className={input + ' mt-2'}
                value={audience}
                onChange={(e) => setAudience(e.target.value as typeof audience)}
              >
                <option value="MEMBERS">Selected members</option>
                <option value="ROLES">Selected roles</option>
                <option value="ALL">Entire school</option>
              </select>
            </label>
            {audience === 'ROLES' && (
              <fieldset>
                <legend className="mb-2 text-sm font-medium">Recipient roles</legend>
                <div className="flex flex-wrap gap-4">
                  {notificationRoles.map((role) => (
                    <label key={role} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={roles.includes(role)}
                        onChange={(e) =>
                          setRoles(
                            e.target.checked ? [...roles, role] : roles.filter((x) => x !== role),
                          )
                        }
                      />
                      {label(role)}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            {audience === 'ALL' && (
              <p className="notice">
                All active accounts in this school will receive this message.
              </p>
            )}
            {audience === 'MEMBERS' && (
              <div className="space-y-3">
                <label className="block text-sm">
                  Find members
                  <input
                    className={input + ' mt-2'}
                    placeholder="Name or email"
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setMemberPage(1);
                    }}
                  />
                </label>
                <p className="text-sm">
                  {ids.length} selected{' '}
                  <Button type="button" size="sm" variant="ghost" onClick={() => setIds([])}>
                    Clear selection
                  </Button>
                </p>
                {members.isLoading ? (
                  <Loading />
                ) : members.error ? (
                  <ErrorState error={members.error} />
                ) : !members.data?.total ? (
                  <p>No active members found.</p>
                ) : (
                  members.data.data.map((m) => (
                    <label
                      key={m.user_id}
                      className="flex items-start gap-3 rounded-xl border border-line p-3"
                    >
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={ids.includes(m.user_id)}
                        onChange={(e) =>
                          setIds(
                            e.target.checked
                              ? [...ids, m.user_id]
                              : ids.filter((x) => x !== m.user_id),
                          )
                        }
                      />
                      <span className="min-w-0 flex-1 break-words text-sm">
                        <strong>{m.full_name || m.email}</strong>
                        <span className="block">{m.email}</span>
                        <span className="text-stone-600">
                          {label(m.role)} ·{' '}
                          {Number(m.push_devices) > 0
                            ? `${m.push_devices} enabled device(s)`
                            : 'Push not enabled'}
                        </span>
                      </span>
                    </label>
                  ))
                )}
                <div className="flex items-center gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={memberPage <= 1}
                    onClick={() => setMemberPage(memberPage - 1)}
                  >
                    Previous members
                  </Button>
                  <span className="text-sm">Page {memberPage}</span>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!members.data || memberPage * 25 >= members.data.total}
                    onClick={() => setMemberPage(memberPage + 1)}
                  >
                    Next members
                  </Button>
                </div>
              </div>
            )}
            <p className="text-sm text-stone-600">
              Push requires permission on each recipient’s device. Members can also read the message
              here. Parent lock-screen privacy and quiet-hour preferences are respected.
            </p>
            <Button variant="lime" disabled={busy}>
              <Send size={16} />
              Review recipients
            </Button>
          </form>
        </Panel>
      )}
      {preview && (
        <Dialog
          open
          title="Confirm notification"
          onOpenChange={(v) => {
            if (!v && !busy) setPreview(null);
          }}
          description="Review the recipients before adding this message to the delivery queue."
        >
          <h3 className="font-semibold break-words">{title}</h3>
          <p className="my-3 whitespace-pre-wrap break-words">{body}</p>
          <p className="notice">
            {preview.recipients} recipient(s) · {preview.push_ready} with push enabled ·{' '}
            {preview.devices} device(s)
          </p>
          <p className="my-4 text-sm text-stone-600">
            School alert settings may suppress delivery. Queued messages are processed by the
            background worker.
          </p>
          {error && (
            <p role="alert" className="field-error">
              {error}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setPreview(null)}>
              Cancel
            </Button>
            <Button
              variant="lime"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api('/notifications/messages', {
                    method: 'POST',
                    headers: { 'Idempotency-Key': sendKey },
                    body: JSON.stringify({
                      title,
                      body,
                      audience: 'MEMBERS',
                      roles: [],
                      user_ids: preview.user_ids,
                    }),
                  });
                  setPreview(null);
                  setTitle('');
                  setBody('');
                  setIds([]);
                  setSuccess('Notification queued. Follow delivery in School history.');
                  setTab('history');
                  setPage(1);
                  await invalidate();
                })
              }
            >
              {busy ? 'Queuing…' : 'Queue notification'}
            </Button>
          </div>
        </Dialog>
      )}
      {tab === 'settings' && manage && (
        <Panel
          title="School alert controls"
          subtitle="Applies to school messages sent from this point forward."
        >
          <div className="space-y-5 p-5">
            {settings.isLoading ? (
              <Loading />
            ) : settings.error ? (
              <ErrorState error={settings.error} />
            ) : (
              config && (
                <>
                  <label className="flex items-center gap-3 font-semibold">
                    <input
                      type="checkbox"
                      checked={config.enabled}
                      onChange={(e) => setDraft({ ...config, enabled: e.target.checked })}
                    />
                    Enable school notifications
                  </label>
                  <fieldset>
                    <legend className="mb-3 font-semibold">Delivery channels</legend>
                    <div className="flex flex-wrap gap-5">
                      {(['PUSH', 'EMAIL', 'SMS'] as const).map((channel) => (
                        <label key={channel} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={config.channels[channel]}
                            onChange={(e) =>
                              setDraft({
                                ...config,
                                channels: { ...config.channels, [channel]: e.target.checked },
                              })
                            }
                          />
                          {channel === 'PUSH' ? 'Firebase push (FCM)' : label(channel)}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset>
                    <legend className="mb-3 font-semibold">Notification types</legend>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {schoolNotificationKinds.map((k) => (
                        <label key={k} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={config.kinds[k]}
                            onChange={(e) =>
                              setDraft({
                                ...config,
                                kinds: { ...config.kinds, [k]: e.target.checked },
                              })
                            }
                          />
                          {label(k)}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <p className="text-sm text-stone-600">
                    Disabling a channel or type suppresses pending deliveries. It cannot recall
                    messages already accepted by a provider. Custom messages use FCM only. Private
                    account-security alerts remain independent.
                  </p>
                  <Button
                    variant="lime"
                    disabled={busy || !draft}
                    onClick={() =>
                      run(async () => {
                        const saved = await api<SchoolNotificationSettings>(
                          '/notifications/settings',
                          { method: 'PUT', body: JSON.stringify(config) },
                        );
                        qc.setQueryData([a.school, 'notification-settings'], saved);
                        setDraft(null);
                        setSuccess('School notification settings saved.');
                      })
                    }
                  >
                    <Settings2 size={16} />
                    Save alert settings
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setDraft(null);
                      void settings.refetch();
                    }}
                  >
                    Reload settings
                  </Button>
                </>
              )
            )}
          </div>
        </Panel>
      )}
      {(tab === 'history' || tab === 'inbox') && (
        <Panel
          title={
            tab === 'history'
              ? details
                ? 'Delivery details'
                : 'School delivery history'
              : 'My notifications'
          }
          subtitle="Accepted means the provider accepted delivery; it does not confirm the message was read."
        >
          <div className="space-y-4 p-5">
            {tab === 'history' && !details && (
              <div className="flex flex-wrap gap-3">
                <label className="text-sm">
                  Type
                  <select
                    className={input + ' mt-1'}
                    value={kind}
                    onChange={(e) => {
                      setKind(e.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="">All types</option>
                    {schoolNotificationKinds.map((k) => (
                      <option key={k}>{k}</option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  Queue status
                  <select
                    className={input + ' mt-1'}
                    value={status}
                    onChange={(e) => {
                      setStatus(e.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="">All statuses</option>
                    {['PENDING', 'PROCESSING', 'COMPLETED', 'DEAD'].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            {details && (
              <Button
                variant="outline"
                onClick={() => {
                  setDetails(null);
                  setPage(1);
                }}
              >
                Back to school history
              </Button>
            )}
            {list.isLoading ? (
              <Loading />
            ) : list.error ? (
              <ErrorState error={list.error} retry={() => void list.refetch()} />
            ) : !list.data?.total ? (
              <p className="py-8 text-center text-stone-600">No notifications yet.</p>
            ) : (
              list.data.data.map((n) => (
                <article
                  key={n.id}
                  className="flex flex-wrap justify-between gap-4 rounded-xl border border-line p-4"
                >
                  <div className="min-w-0 flex-1">
                    <h3 className="font-semibold break-words">
                      {details
                        ? n.full_name || n.email || 'Recipient'
                        : n.payload?.title || label(n.kind)}
                    </h3>
                    {n.payload?.body && (
                      <p className="mt-2 whitespace-pre-wrap break-words text-sm">
                        {n.payload.body}
                      </p>
                    )}
                    <p className="mt-2 text-xs text-stone-600">
                      {display(n.created_at, a.me?.school?.timezone)}
                      {n.channel && ` · ${n.channel}`}
                    </p>
                    {tab === 'history' && !details && (
                      <p className="mt-2 text-sm">
                        {n.recipients ? `${n.recipients} selected recipient(s) · ` : ''}
                        {n.accepted} accepted · {n.failed} failed
                      </p>
                    )}
                    {n.last_error && (
                      <p className="mt-2 break-words text-xs text-stone-600">
                        {label(n.last_error)}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-start gap-2">
                    <Badge>{n.cancelled_at ? 'CANCELLED' : n.status}</Badge>
                    {tab === 'history' && !details && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setDetails(n.id);
                          setPage(1);
                        }}
                      >
                        Delivery details
                      </Button>
                    )}
                    {manage &&
                      tab === 'history' &&
                      !details &&
                      ['PENDING', 'PROCESSING'].includes(n.status) &&
                      !n.cancelled_at && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setAction({
                              path: `/notifications/messages/${n.id}/cancel`,
                              title: 'Cancel pending notification',
                            });
                            setReason('');
                          }}
                        >
                          Cancel queued
                        </Button>
                      )}
                    {manage &&
                      details &&
                      (['FAILED', 'DEAD'].includes(n.status) ||
                        (n.status === 'SUPPRESSED' &&
                          ['NO_ENABLED_DEVICE', 'SCHOOL_POLICY_DISABLED'].includes(
                            n.last_error || '',
                          ))) && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setAction({
                              path: `/notifications/${n.id}/retry`,
                              title: 'Retry delivery',
                            });
                            setReason('');
                          }}
                        >
                          Retry delivery
                        </Button>
                      )}
                  </div>
                </article>
              ))
            )}
            <div className="flex items-center justify-between gap-2">
              <Button variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Previous page
              </Button>
              <span className="text-xs">
                Page {page} · {list.data?.total || 0} records
              </span>
              <Button
                variant="outline"
                disabled={!list.data || page * list.data.page_size >= list.data.total}
                onClick={() => setPage(page + 1)}
              >
                Next page
              </Button>
            </div>
          </div>
        </Panel>
      )}
      {action && (
        <Dialog
          open
          title={action.title}
          onOpenChange={(v) => {
            if (!v && !busy) setAction(null);
          }}
          description="Actions are recorded in your school’s audit history. Messages already accepted by FCM cannot be recalled."
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api(action.path, { method: 'POST', body: JSON.stringify({ reason }) });
                setAction(null);
                setSuccess('Notification updated.');
                await invalidate();
              });
            }}
          >
            <label className="block text-sm">
              Reason
              <textarea
                className={input + ' mt-2'}
                required
                minLength={5}
                maxLength={1000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            {error && (
              <p role="alert" className="field-error">
                {error}
              </p>
            )}
            <Button className="mt-4" variant="lime" disabled={busy}>
              Confirm
            </Button>
          </form>
        </Dialog>
      )}
    </>
  );
}
