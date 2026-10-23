import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Laptop, ShieldCheck, Smartphone, RefreshCw } from 'lucide-react';
import type { LoginSession, LoginSessionsResponse } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { PageHeading, Panel, Badge, Loading, ErrorState } from '../../components/common';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import AuthenticatorSetup from './AuthenticatorSetup';

const timestamp = (date: string | null) =>
  date
    ? new Date(date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : 'Not available';
export default function LoginSessions() {
  const a = useAuth();
  const sessions = useQuery({
    queryKey: ['account-sessions', a.me?.id],
    queryFn: () => api<LoginSessionsResponse>('/account/sessions'),
    enabled: !!a.session,
    refetchInterval: 30000,
  });
  const [target, setTarget] = useState<LoginSession | 'others' | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [success, setSuccess] = useState('');
  async function terminate() {
    if (!target || busy) return;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const result = await api<{ ended: number; current_session_ended: boolean }>(
        target === 'others' ? '/account/sessions/logout-others' : '/account/sessions/' + target.id,
        { method: target === 'others' ? 'POST' : 'DELETE' },
      );
      if (result.current_session_ended) {
        await a.logout();
        return;
      }
      setSuccess(
        result.ended
          ? `${result.ended} login session${result.ended === 1 ? '' : 's'} ended.`
          : 'There are no other active sessions.',
      );
      setTarget(null);
      await sessions.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not end the session. Please try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        title="Security & Login Sessions"
        description="See where you’re signed in and manage access to your account."
        actions={
          <Button asChild variant="outline">
            <Link to="../settings">Account settings</Link>
          </Button>
        }
      />
      <div className="mb-6 flex items-start gap-3 rounded-2xl border border-line bg-lime/10 p-5 text-sm">
        <ShieldCheck className="mt-0.5 shrink-0" size={22} />
        <p>
          Only you can view and manage these sessions. Device and browser names are estimates. IP
          addresses come from the sign-in provider; precise location is not collected. Tabs in the
          same browser can share one session.
        </p>
      </div>
      <Panel
        title="Active login sessions"
        subtitle="Sessions that are still present with your sign-in provider."
      >
        <div className="p-5 sm:p-6">
          <div className="mb-5 flex flex-wrap justify-between gap-3">
            <p className="text-sm text-stone-600">
              {sessions.data?.data.length ?? 0} active session(s) · Times are shown in your device’s
              timezone.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={sessions.isFetching || busy}
                onClick={() => sessions.refetch()}
              >
                <RefreshCw size={15} /> Refresh sessions
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !sessions.data?.data.some((s) => !s.is_current)}
                onClick={() => {
                  setError('');
                  setTarget('others');
                }}
              >
                Log out all other devices
              </Button>
            </div>
          </div>
          {success && (
            <p role="status" className="mb-4 rounded-xl bg-lime/20 p-3 text-sm">
              {success}
            </p>
          )}
          {sessions.isLoading ? (
            <Loading />
          ) : sessions.error ? (
            <ErrorState error={sessions.error} retry={() => sessions.refetch()} />
          ) : sessions.data?.data.length ? (
            <div className="space-y-4">
              {sessions.data.data.map((s) => (
                <article
                  key={s.id}
                  className="rounded-2xl border border-line p-4 sm:p-5"
                  aria-label={`${s.browser} on ${s.device}${s.is_current ? ' · Current session' : ''}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="rounded-xl bg-lime/20 p-3">
                        {/iPhone|iPad|Android/.test(s.device) ? (
                          <Smartphone size={22} />
                        ) : (
                          <Laptop size={22} />
                        )}
                      </span>
                      <div>
                        <h3 className="font-semibold">{s.device}</h3>
                        <p className="text-sm text-stone-600">{s.browser}</p>
                      </div>
                    </div>
                    {s.is_current && <Badge>Current session</Badge>}
                  </div>
                  <dl className="my-4 grid gap-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
                    <div>
                      <dt className="text-stone-500">IP address</dt>
                      <dd className="break-all">{s.ip_address || 'Not available'}</dd>
                    </div>
                    <div>
                      <dt className="text-stone-500">Approximate location</dt>
                      <dd>{s.location || 'Not available'}</dd>
                    </div>
                    <div>
                      <dt className="text-stone-500">Login time</dt>
                      <dd>{timestamp(s.login_at)}</dd>
                    </div>
                    <div>
                      <dt className="text-stone-500">Last active</dt>
                      <dd>{timestamp(s.last_active_at)}</dd>
                    </div>
                  </dl>
                  {s.expires_at && (
                    <p className="mb-3 text-xs text-stone-500">
                      Session ends {timestamp(s.expires_at)}
                    </p>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setError('');
                      setTarget(s);
                    }}
                  >
                    {s.is_current ? 'Log out this device' : 'End session'}
                  </Button>
                </article>
              ))}
            </div>
          ) : (
            <p>No active login sessions found. Refresh to check again.</p>
          )}
        </div>
      </Panel>
      <div className="mt-6">
        <Panel
          title="Recent account security activity"
          subtitle="New login alerts and session controls from the last 90 days."
        >
          <div className="p-5 sm:p-6">
            <p className="mb-4 text-sm text-stone-600">
              New logins appear here when they first access Vidyalayaa. Email alerts use the
              existing email service when configured. Older sessions present before this feature was
              enabled do not trigger new-login alerts.
            </p>
            <ul className="divide-y divide-line">
              {sessions.data?.events.map((event) => (
                <li key={event.id} className="flex flex-wrap justify-between gap-2 py-3 text-sm">
                  <span>
                    {event.kind === 'NEW_LOGIN'
                      ? 'New login detected'
                      : event.kind === 'OTHER_SESSIONS_ENDED'
                        ? `${event.affected_count} other session(s) ended`
                        : 'Login session ended'}
                    {event.kind === 'NEW_LOGIN' && event.email_status === 'SENT' && ' · Email sent'}
                  </span>
                  <time dateTime={event.created_at} className="text-stone-500">
                    {timestamp(event.created_at)}
                  </time>
                </li>
              ))}
            </ul>
            {!sessions.data?.events.length && (
              <p className="text-sm text-stone-500">No recent account security events.</p>
            )}
          </div>
        </Panel>
      </div>
      <div className="mt-6">
        <Panel
          title="Multi-factor authentication"
          subtitle="Protect sign-in with your authenticator app."
        >
          <AuthenticatorSetup />
        </Panel>
      </div>
      <Dialog
        open={!!target}
        onOpenChange={(open) => {
          if (!open && !busy) setTarget(null);
        }}
        title={
          target === 'others'
            ? 'Log out all other devices?'
            : target?.is_current
              ? 'Log out this device?'
              : 'End this login session?'
        }
        description={
          target === 'others'
            ? 'Your current session will stay signed in. Other devices will need to sign in again.'
            : 'This device will lose access and need to sign in again.'
        }
      >
        {error && (
          <p className="field-error mb-4" role="alert">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="outline" disabled={busy} onClick={() => setTarget(null)}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={terminate}>
            {busy
              ? 'Ending session…'
              : target === 'others'
                ? 'Confirm logout of other devices'
                : 'Confirm logout'}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
