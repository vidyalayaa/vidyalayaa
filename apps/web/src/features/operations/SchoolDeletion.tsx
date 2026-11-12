import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Panel } from '../../components/common';
import { api, assertAccountIdentity, getSignInFactor, supabase, useAuth } from '../../lib/auth';
import { fromDateTimeLocal } from '../../lib/utils';

type Mode = 'request' | 'close' | 'hold' | 'execute';
type Row = Record<string, unknown>;
type Approval = {
  id: string;
  reason: string;
  policy_ref: string;
  approval_expires_at: string;
  export_until: string;
  delete_after: string;
  token: string;
};

async function verifyAuthenticator(userId: string, code: string) {
  await assertAccountIdentity(userId);
  const factorId = await getSignInFactor(true);
  if (!factorId) throw new Error('Set up a verified authenticator in Account Settings.');
  const result = await supabase!.auth.mfa.challengeAndVerify({ factorId, code });
  if (result.error) throw new Error('The authenticator code could not be verified.');
  await assertAccountIdentity(userId);
}

function AuthenticatorCode() {
  return (
    <label className="grid gap-1 text-sm font-medium">
      Code from your authenticator
      <input
        className="input"
        name="mfa_code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        required
      />
    </label>
  );
}

function ConfirmationFields({ name }: { name: string }) {
  return (
    <>
      <label className="grid gap-1 text-sm font-medium">
        Type DELETE
        <input name="confirm" className="input" required pattern="DELETE" autoComplete="off" />
      </label>
      <label className="grid gap-1 text-sm font-medium">
        Type the exact school name
        <input name="school_name" className="input" required autoComplete="off" />
        <span className="text-stone-600">{name}</span>
      </label>
    </>
  );
}

const date = (value: unknown) => new Date(String(value)).toLocaleString();

export function SchoolDeletionDialog({
  row,
  mode,
  close,
  onSuccess,
}: {
  row: Row;
  mode: Mode;
  close: () => void;
  onSuccess: () => void;
}) {
  const auth = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const schoolId = String(mode === 'request' ? row.id : row.school_id);
  const name = String(mode === 'request' ? row.name : row.school_name);
  const schoolPath = `/platform/schools/${schoolId}`;
  const approvers = useQuery({
    queryKey: [auth.me?.id, 'platform', 'deletion-approvers', schoolId],
    queryFn: () =>
      api<{ data: { id: string; full_name: string }[] }>(schoolPath + '/deletion-approvers'),
    enabled: mode === 'request',
  });
  const title = {
    request: 'Permanently delete school',
    close: 'Close school for its final export',
    hold: 'Change legal hold',
    execute: 'Final confirmation for permanent deletion',
  }[mode];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !auth.me) return;
    setError('');
    const form = new FormData(event.currentTarget);
    const field = (name: string) => String(form.get(name) ?? '');
    const confirmation = { confirm: field('confirm'), school_name: field('school_name') };
    if (
      (mode === 'request' || mode === 'execute') &&
      (confirmation.confirm !== 'DELETE' || confirmation.school_name !== name)
    ) {
      setError('Type DELETE and enter the exact school name.');
      return;
    }
    const context = { userId: auth.me.id, schoolId: auth.requestSchool };
    setBusy(true);
    try {
      const timezone = String(row.timezone || 'Asia/Kolkata');
      const body = {
        request: () => ({
          ...confirmation,
          approver_id: field('approver_id'),
          policy_ref: field('policy_ref'),
          reason: field('reason'),
          export_until: fromDateTimeLocal(field('export_until'), timezone),
          delete_after: fromDateTimeLocal(field('delete_after'), timezone),
        }),
        close: () => ({ confirm: 'CLOSE_SCHOOL' }),
        hold: () => ({
          enabled: field('hold') === 'true',
          policy_ref: row.policy_ref,
          reason: field('reason'),
        }),
        execute: () => confirmation,
      }[mode]();
      const endpoint = {
        request: schoolPath + '/permanent-deletion',
        close: `/platform/offboarding/${row.id}/close`,
        hold: `/platform/offboarding/${row.id}/hold`,
        execute: `${schoolPath}/permanent-deletion/${row.id}/execute`,
      }[mode];
      await verifyAuthenticator(context.userId, field('mfa_code'));
      await api(endpoint, { method: 'POST', body: JSON.stringify(body) }, true, 'json', context);
      onSuccess();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The request failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={title}
      description={name}
      onOpenChange={(open) => !open && !busy && close()}
    >
      <form className="grid gap-4" onSubmit={submit}>
        {(mode === 'request' || mode === 'execute') && (
          <div className="flex items-start gap-2 rounded-md bg-red-50 p-3 text-sm text-red-900">
            <TriangleAlert size={18} className="mt-0.5 shrink-0" aria-hidden />
            <div>
              <p className="font-semibold">This permanently removes the school and its records.</p>
              <p className="mt-1">
                School files, academic and fee records, and accounts used only by this school will
                be erased.
                {mode === 'execute'
                  ? ' Deletion becomes irreversible as soon as the worker starts. This can happen immediately after you confirm.'
                  : ' The selected School Admin must approve from their school dashboard using their own account and authenticator.'}
              </p>
            </div>
          </div>
        )}
        {mode === 'close' && (
          <p className="text-sm">
            Closing suspends school access and revokes readers, active invitations, and
            integrations. A School Admin will have until {date(row.export_until)} or 24 hours after
            closure, whichever is later, to create and download the final export.
          </p>
        )}
        {mode === 'hold' && (
          <label className="grid gap-1 text-sm font-medium">
            Legal hold
            <select name="hold" className="input" defaultValue={String(row.legal_hold)}>
              <option value="true">Block permanent deletion</option>
              <option value="false">Release hold</option>
            </select>
          </label>
        )}
        {(mode === 'request' || mode === 'execute') && <ConfirmationFields name={name} />}
        {mode === 'request' && (
          <>
            <label className="grid gap-1 text-sm font-medium">
              School Admin who will approve
              <select className="input" name="approver_id" required defaultValue="">
                <option value="" disabled>
                  {approvers.isLoading
                    ? 'Loading verified School Admins…'
                    : 'Select a verified School Admin'}
                </option>
                {approvers.data?.data.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.full_name}
                  </option>
                ))}
              </select>
            </label>
            {approvers.error && (
              <p role="alert" className="text-sm text-red-800">
                {approvers.error.message}
              </p>
            )}
            {approvers.data?.data.length === 0 && (
              <p className="text-sm">
                An active School Admin must verify their email and enroll an authenticator before a
                request can be sent.
              </p>
            )}
            <label className="grid gap-1 text-sm font-medium">
              Retention policy reference
              <input className="input" name="policy_ref" minLength={5} maxLength={200} required />
            </label>
            <p className="text-sm text-stone-600">
              Allow at least 24 hours for the final export. Enter both deadlines in{' '}
              {String(row.timezone || 'Asia/Kolkata')}.
            </p>
            <label className="grid gap-1 text-sm font-medium">
              Export available until
              <input className="input" name="export_until" type="datetime-local" required />
            </label>
            <label className="grid gap-1 text-sm font-medium">
              Earliest permanent deletion
              <input className="input" name="delete_after" type="datetime-local" required />
            </label>
          </>
        )}
        {(mode === 'request' || mode === 'hold') && (
          <label className="grid gap-1 text-sm font-medium">
            Reason
            <textarea className="input" name="reason" minLength={10} maxLength={2000} required />
          </label>
        )}
        <AuthenticatorCode />
        {error && (
          <p role="alert" className="text-sm text-red-800">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="destructive"
            disabled={busy || (mode === 'request' && !approvers.data?.data.length)}
          >
            {busy
              ? 'Verifying…'
              : {
                  request: 'Send approval request',
                  close: 'Close school',
                  hold: 'Save legal hold',
                  execute: 'Permanently delete school',
                }[mode]}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function SchoolDeletionApproval() {
  const auth = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [decision, setDecision] = useState('');
  const pending = useQuery({
    queryKey: [auth.school, auth.me?.id, 'school-deletion-approval'],
    queryFn: () =>
      api<{ request: Approval | null }>('/offboarding/deletion-approval', { cache: 'no-store' }),
    enabled: auth.me?.school?.role === 'school_admin',
    refetchInterval: 30000,
    gcTime: 0,
  });
  const request = pending.data?.request;
  if (!request)
    return decision ? (
      <p role="status" className="notice">
        {decision}
      </p>
    ) : null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !auth.me || !request) return;
    const form = new FormData(event.currentTarget);
    const approve = form.get('decision') === 'approve';
    const context = { userId: auth.me.id, schoolId: auth.requestSchool };
    setBusy(true);
    setError('');
    try {
      await verifyAuthenticator(context.userId, String(form.get('mfa_code') ?? ''));
      await api(
        `/offboarding/deletion-approval/${request.id}`,
        {
          method: 'POST',
          body: JSON.stringify({ token: request.token, approve }),
        },
        true,
        'json',
        context,
      );
      setOpen(false);
      setDecision(
        approve
          ? 'Deletion approved. A Super Admin still has to close and permanently delete the school.'
          : 'Deletion request declined.',
      );
      await qc.invalidateQueries({ queryKey: [auth.school] });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The decision could not be recorded.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Permanent deletion approval"
      subtitle={`This request expires ${date(request.approval_expires_at)}.`}
      className="[&>.panel-heading]:flex-wrap [&>.panel-heading]:py-4"
      action={
        <Button
          type="button"
          variant="outline"
          className="ml-auto shrink-0"
          onClick={() => {
            setError('');
            setOpen(true);
          }}
        >
          Review deletion request
        </Button>
      }
    >
      <Dialog
        open={open}
        title="Approve permanent school deletion?"
        description={auth.me?.school?.school_name}
        onOpenChange={(value) => !busy && setOpen(value)}
      >
        <form className="grid gap-4" onSubmit={submit}>
          <p className="text-sm">
            Approval authorizes a Super Admin to close this school and later erase its records,
            files, and school-only accounts.
          </p>
          <dl className="grid gap-2 text-sm">
            <div>
              <dt className="font-semibold">Reason</dt>
              <dd className="break-words">{request.reason}</dd>
            </div>
            <div>
              <dt className="font-semibold">Retention policy</dt>
              <dd>{request.policy_ref}</dd>
            </div>
            <div>
              <dt className="font-semibold">Export available until</dt>
              <dd>{date(request.export_until)}</dd>
            </div>
            <div>
              <dt className="font-semibold">Earliest permanent deletion</dt>
              <dd>{date(request.delete_after)}</dd>
            </div>
          </dl>
          <label className="grid gap-1 text-sm font-medium">
            Your decision
            <select name="decision" className="input" defaultValue="" required>
              <option value="" disabled>
                Select a decision
              </option>
              <option value="approve">Approve permanent deletion</option>
              <option value="decline">Decline</option>
            </select>
          </label>
          <AuthenticatorCode />
          {error && (
            <p role="alert" className="text-sm text-red-800">
              {error}
            </p>
          )}
          <Button type="submit" variant="destructive" disabled={busy}>
            {busy ? 'Verifying…' : 'Record decision'}
          </Button>
        </form>
      </Dialog>
    </Panel>
  );
}
