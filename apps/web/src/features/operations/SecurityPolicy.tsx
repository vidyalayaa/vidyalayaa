import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  securityPolicyDefaults,
  type SchoolSecurityEvent,
  type SchoolSecurityPolicy,
} from '@vidyalayaa/contracts';
import { api, getSignInFactor, supabase, useAuth } from '../../lib/auth';
import { Panel, Loading, ErrorState } from '../../components/common';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';

const controls = [
  ['require_privileged_mfa', 'Require MFA for School Admins and Principals'],
  ['mfa_teachers', 'Require MFA for Teachers'],
  ['mfa_finance_staff', 'Require MFA for Finance Staff'],
  ['step_up_sensitive', 'Require recent verification for sensitive changes'],
  ['student_login_enabled', 'Allow invited student accounts to sign in'],
  ['parent_login_enabled', 'Allow parent accounts to sign in'],
  ['new_login_alerts', 'Notify users of new sign-ins'],
  ['suspicious_login_alerts', 'Alert users to sign-ins from unfamiliar networks'],
] as const;
const mfaControls = [
  'require_privileged_mfa',
  'mfa_teachers',
  'mfa_finance_staff',
  'step_up_sensitive',
] as const;

type PolicyInput = typeof securityPolicyDefaults;
type Pending = { input: PolicyInput; mfaIncreased: boolean; restrictive: boolean };

function SecurityRecords({ school, kind }: { school: string; kind: 'history' | 'audit' }) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(1);
  const history = kind === 'history';
  const q = useQuery({
    queryKey: [school, 'security-policy', kind, page],
    queryFn: () =>
      api<{ data: (SchoolSecurityPolicy | SchoolSecurityEvent)[]; more: boolean }>(
        '/school/security/' + kind + '?page_size=15&page=' + page,
      ),
    enabled: expanded,
  });
  return (
    <details
      className="rounded-xl border p-4"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="cursor-pointer font-semibold">
        {history ? 'Policy version history' : 'Security audit log'}
      </summary>
      {expanded && (
        <div className="mt-3 space-y-3">
          {!history && (
            <p className="text-sm text-stone-600">
              Last 90 days. Provider events appear when Supabase records them and they can be
              attributed to this school.
            </p>
          )}
          {q.isLoading ? (
            <Loading />
          ) : q.error ? (
            <ErrorState error={q.error} retry={() => q.refetch()} />
          ) : (
            <>
              {!q.data?.data.length && (
                <p className="text-sm text-stone-600">
                  {history
                    ? 'No saved policy versions yet.'
                    : 'No security events for this period.'}
                </p>
              )}
              <ul className="divide-y">
                {q.data?.data.map((record) =>
                  'version' in record ? (
                    <li key={record.version} className="py-3">
                      <details>
                        <summary className="cursor-pointer font-medium">
                          Version {record.version} · {record.policy_ref || 'Original settings'}
                        </summary>
                        <p className="mt-2 text-sm text-stone-600">
                          {record.approved_at
                            ? new Date(record.approved_at).toLocaleString()
                            : 'Approval date unavailable'}{' '}
                          · {record.approved_by_name || 'Approver unavailable'}
                        </p>
                        {record.approval_details && (
                          <p className="mt-2 whitespace-pre-wrap text-sm">
                            {record.approval_details}
                          </p>
                        )}
                        <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
                          {controls.map(([name, label]) => (
                            <div key={name}>
                              <dt>{label}</dt>
                              <dd className="text-stone-600">
                                {record[name] ? 'Enabled' : 'Disabled'}
                              </dd>
                            </div>
                          ))}
                          <div>
                            <dt>Reader offline threshold</dt>
                            <dd>{record.device_offline_minutes} minutes</dd>
                          </div>
                          <div>
                            <dt>Inactivity timeout</dt>
                            <dd>
                              {record.idle_timeout_minutes
                                ? record.idle_timeout_minutes + ' minutes'
                                : 'Disabled'}
                            </dd>
                          </div>
                        </dl>
                      </details>
                    </li>
                  ) : (
                    <li key={record.id} className="py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <strong>{record.action}</strong>
                        <span className="text-xs font-medium">
                          {record.outcome} ·{' '}
                          {record.source === 'SUPABASE' ? 'Supabase' : 'Vidyalayaa'}
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-stone-600">
                        {new Date(record.occurred_at).toLocaleString()} · Actor{' '}
                        {record.actor || 'Unavailable'} · Account {record.account || 'Unavailable'}
                      </p>
                      {(record.device || record.ip_address) && (
                        <p className="mt-1 break-words text-sm text-stone-600">
                          {[record.device, record.ip_address].filter(Boolean).join(' · ')}
                        </p>
                      )}
                    </li>
                  ),
                )}
              </ul>
              {(page > 1 || q.data?.more) && (
                <div className="flex gap-2">
                  <Button variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)}>
                    Previous page
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!q.data?.more}
                    onClick={() => setPage(page + 1)}
                  >
                    Next page
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </details>
  );
}

function PolicyForm({
  policy,
  onSaved,
  checkRecovery,
  checkingRecovery,
}: {
  policy: SchoolSecurityPolicy;
  onSaved: (saved: SchoolSecurityPolicy) => void;
  checkRecovery: () => void;
  checkingRecovery: boolean;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const verify = !!pending && (pending.mfaIncreased || policy.step_up_sensitive);

  async function save(draft: Pending, code?: string) {
    setSaving(true);
    setError('');
    try {
      if (code) {
        const factorId = await getSignInFactor(true);
        if (!supabase || !factorId)
          throw new Error('Set up and verify an authenticator in Account security first.');
        const result = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
        if (result.error)
          throw new Error('The authenticator code could not be verified. Try a fresh code.');
      }
      const saved = await api<SchoolSecurityPolicy>('/school/security', {
        method: 'PUT',
        body: JSON.stringify({
          ...draft.input,
          expected_version: policy.version,
          confirm_enforcement: draft.restrictive,
        }),
      });
      setPending(null);
      onSaved(saved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const idle = String(fields.get('idle'));
    const input: PolicyInput = {
      require_privileged_mfa: fields.has('require_privileged_mfa'),
      mfa_teachers: fields.has('mfa_teachers'),
      mfa_finance_staff: fields.has('mfa_finance_staff'),
      step_up_sensitive: fields.has('step_up_sensitive'),
      student_login_enabled: fields.has('student_login_enabled'),
      parent_login_enabled: fields.has('parent_login_enabled'),
      new_login_alerts: fields.has('new_login_alerts'),
      suspicious_login_alerts: fields.has('suspicious_login_alerts'),
      idle_timeout_minutes: idle ? Number(idle) : null,
      device_offline_minutes: Number(fields.get('offline')),
      policy_ref: String(fields.get('ref')),
      approval_details: String(fields.get('approval')).trim(),
    };
    const mfaIncreased = mfaControls.some((key) => input[key] && !policy[key]);
    if (mfaIncreased && (!policy.recovery_ready || !input.approval_details)) {
      setError(
        'Set up your authenticator, have a second active School Admin sign in with MFA, and record the recovery steps in the approval details.',
      );
      return;
    }
    const restrictive =
      mfaIncreased ||
      (policy.student_login_enabled && !input.student_login_enabled) ||
      (policy.parent_login_enabled && !input.parent_login_enabled) ||
      (input.idle_timeout_minutes !== null &&
        (policy.idle_timeout_minutes === null ||
          input.idle_timeout_minutes < policy.idle_timeout_minutes));
    const draft = { input, mfaIncreased, restrictive };
    setError('');
    if (restrictive || policy.step_up_sensitive) setPending(draft);
    else void save(draft);
  }

  return (
    <>
      <form className="space-y-4" onSubmit={submit}>
        <div className="rounded-xl border p-4 text-sm text-stone-600">
          <p>
            Version {policy.version} ·{' '}
            {policy.approved_at
              ? 'Updated ' + new Date(policy.approved_at).toLocaleString()
              : 'Original settings'}
          </p>
          {policy.approved_by_name && <p>Updated by {policy.approved_by_name}</p>}
        </div>
        <fieldset disabled={saving} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {controls.map(([name, label]) => (
              <label key={name} className="flex items-start gap-3 rounded-xl border p-3 text-sm">
                <input
                  className="mt-0.5"
                  type="checkbox"
                  name={name}
                  defaultChecked={policy[name]}
                />
                {label}
              </label>
            ))}
          </div>
          <p className="text-sm text-stone-600">
            Super Admin MFA is always required. Security activity appears in Login Sessions. Enabled
            alerts can also send email through the configured worker.
          </p>
          {!policy.recovery_ready && (
            <Button
              type="button"
              variant="outline"
              onClick={checkRecovery}
              disabled={checkingRecovery}
            >
              {checkingRecovery ? 'Checking recovery…' : 'Check recovery again'}
            </Button>
          )}
          <p className="text-sm text-stone-600">
            {policy.recovery_ready
              ? 'Recovery check passed. A second active School Admin signed in with a verified authenticator within the past seven days.'
              : 'To increase MFA enforcement, set up your authenticator and have a second active School Admin sign in with theirs within seven days.'}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="field-label block">
              Inactivity timeout (minutes)
              <input
                className="input mt-2"
                type="number"
                min="5"
                max="240"
                name="idle"
                defaultValue={policy.idle_timeout_minutes ?? ''}
                aria-describedby="school-idle-help"
              />
              <span id="school-idle-help" className="mt-1 block text-xs text-stone-600">
                Leave blank to disable. Idle sessions sign out automatically.
              </span>
            </label>
            <label className="field-label block">
              Reader offline threshold (minutes)
              <input
                className="input mt-2"
                type="number"
                min="1"
                max="60"
                name="offline"
                defaultValue={policy.device_offline_minutes}
                required
              />
            </label>
          </div>
          <label className="field-label block">
            Policy approval reference
            <input
              className="input mt-2"
              name="ref"
              minLength={5}
              maxLength={200}
              defaultValue={policy.policy_ref}
              required
            />
          </label>
          <label className="field-label block">
            Approval and recovery details
            <textarea
              className="input mt-2 min-h-20"
              name="approval"
              maxLength={1000}
              defaultValue={policy.approval_details}
            />
          </label>
          <p className="text-xs text-stone-600">
            Record who approved the change and how the backup administrator can recover access. Keep
            passwords, authenticator codes and keys out of these notes.
          </p>
        </fieldset>
        {error && !pending && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <Button variant="lime" disabled={saving}>
          {saving ? 'Saving…' : 'Save security policy'}
        </Button>
      </form>
      <Dialog
        open={!!pending}
        onOpenChange={(open) => {
          if (!open && !saving) {
            setPending(null);
            setError('');
          }
        }}
        title={pending?.restrictive ? 'Confirm security enforcement' : 'Verify this policy change'}
        description="Review the impact before saving this version of the school’s security policy."
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (pending)
              void save(
                pending,
                verify ? String(new FormData(event.currentTarget).get('code')) : undefined,
              );
          }}
        >
          {pending?.mfaIncreased && (
            <p>
              Users in affected roles will need an authenticator before accessing the workspace.
              Confirm the backup administrator can sign in before proceeding.
            </p>
          )}
          {pending &&
            ((!pending.input.student_login_enabled && policy.student_login_enabled) ||
              (!pending.input.parent_login_enabled && policy.parent_login_enabled)) && (
              <p>
                Active accounts in the selected roles will lose access to this school immediately.
              </p>
            )}
          {pending?.input.idle_timeout_minutes !== null &&
            pending?.input.idle_timeout_minutes !== policy.idle_timeout_minutes && (
              <p>
                The new inactivity limit applies to existing sessions after the new timeout window.
              </p>
            )}
          {verify && (
            <label className="field-label block">
              Authenticator code
              <input
                className="input mt-2"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
              />
            </label>
          )}
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => {
                setPending(null);
                setError('');
              }}
            >
              Cancel
            </Button>
            <Button variant="lime" disabled={saving}>
              {saving ? 'Saving…' : 'Confirm and save'}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

export default function SecurityPolicy() {
  const { school } = useAuth();
  const qc = useQueryClient();
  const [savedVersion, setSavedVersion] = useState<number | null>(null);
  const key = [school, 'security-policy'];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<SchoolSecurityPolicy>('/school/security'),
  });
  return (
    <Panel
      title="School security policy"
      subtitle="Manage authentication, session expiry, and sign-in alerts for your school."
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : (
        q.data && (
          <div className="settings-body space-y-4">
            <PolicyForm
              key={school + ':' + q.data.version}
              policy={q.data}
              checkRecovery={() => void q.refetch()}
              checkingRecovery={q.isFetching}
              onSaved={(saved) => {
                qc.setQueryData(key, saved);
                void qc.invalidateQueries({ queryKey: key });
                void qc.invalidateQueries({ queryKey: ['me'] });
                setSavedVersion(saved.version);
              }}
            />
            {savedVersion === q.data.version && (
              <p role="status" className="text-sm font-medium">
                Security policy saved.
              </p>
            )}
            <SecurityRecords key={school + ':history'} school={school} kind="history" />
            <SecurityRecords key={school + ':audit'} school={school} kind="audit" />
            <p className="text-sm text-stone-600">
              Password strength and rate limits are managed in Supabase Auth. Custom account
              lockouts require a supported Auth hook. Suspend school access through Members &amp;
              Invitations.
            </p>
          </div>
        )
      )}
    </Panel>
  );
}
