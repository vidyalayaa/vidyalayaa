import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, KeyRound, Mail, ShieldCheck } from 'lucide-react';
import type { AccountCredentials } from '@vidyalayaa/contracts';
import {
  AccountMfaRequired,
  api,
  assertAccountIdentity,
  confirmAccountAssurance,
  requestPasswordLink,
  supabase,
  updateOwnAccount,
  useAuth,
} from '../../lib/auth';
import { PageHeading, Panel, Loading, ErrorState } from '../../components/common';
import { Button } from '../../components/ui/button';
import { AppearanceSettings } from '../../components/ThemeSelect';

export default function AccountSettings() {
  const auth = useAuth();
  const client = useQueryClient();
  const id = auth.session?.user.id || '';
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mfa, setMfa] = useState(false);
  const [nonceSent, setNonceSent] = useState(false);
  const state = useQuery({
    queryKey: ['account-credentials', id],
    queryFn: () => api<AccountCredentials>('/account/credentials'),
    enabled: !!id,
    staleTime: 0,
    retry: false,
  });
  async function action(work: () => Promise<string>) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError('');
    setNotice('');
    try {
      setNotice(await work());
      await client.invalidateQueries({ queryKey: ['account-credentials', id] });
      auth.refetch();
    } catch (cause) {
      if (cause instanceof AccountMfaRequired) setMfa(true);
      setError((cause as Error).message);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  async function sendPasswordSetup() {
    await action(async () => {
      const user = await assertAccountIdentity(id);
      if (!user.email || !user.email_confirmed_at)
        throw new Error('Verify your current email address first.');
      await requestPasswordLink(user.email);
      return 'A secure password setup link has been requested for your verified email. Open it to choose your password.';
    });
  }
  return (
    <>
      <PageHeading
        title="Email & password"
        description="Keep your account connected and your sign-in secure."
        actions={
          <Button asChild variant="outline">
            <Link to="/settings">
              <ArrowLeft size={16} />
              Back to settings
            </Link>
          </Button>
        }
      />
      <AppearanceSettings className="mb-6" />
      {state.isLoading ? (
        <Loading />
      ) : state.error ? (
        <ErrorState error={state.error} retry={() => state.refetch()} />
      ) : !state.data ? (
        <p>Sign in to manage your account.</p>
      ) : (
        <>
          <div className="notice mb-6">
            <ShieldCheck size={20} />
            <p className="text-sm leading-6">
              Changes apply only to your own account. Your school roles, records, and existing
              Google sign-in stay connected.
            </p>
          </div>
          {notice && (
            <p
              className="mb-6 rounded-xl border border-lime-200 bg-lime-50 p-4 text-sm text-green-900"
              role="status"
            >
              {notice}
            </p>
          )}
          {error && (
            <p className="field-error mb-6" role="alert">
              {error}
            </p>
          )}
          <div className="grid items-start gap-6 xl:grid-cols-2">
            <Panel
              title="Change email"
              subtitle="Verify both addresses before your account email changes."
            >
              <form
                className="space-y-5 p-6"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  const fields = new FormData(form);
                  void action(async () => {
                    const email = String(fields.get('new_email')).trim().toLowerCase();
                    const user = await assertAccountIdentity(id);
                    if (!user.email_confirmed_at)
                      throw new Error('Verify your current email address first.');
                    if (email === user.email?.toLowerCase())
                      throw new Error('Enter a different email address.');
                    await confirmAccountAssurance(id, String(fields.get('mfa_code') || ''));
                    await updateOwnAccount(id, { email });
                    form.reset();
                    return 'Verification emails have been requested. Confirm the change in both your current and new inboxes. Your account email stays unchanged until verification completes.';
                  });
                }}
              >
                <p className="text-sm text-stone-600">
                  Current email <strong className="break-all text-ink">{state.data.email}</strong>
                </p>
                {state.data.pending_email && (
                  <p className="rounded-xl bg-stone-50 p-3 text-sm leading-6">
                    Awaiting verification:{' '}
                    <strong className="break-all">{state.data.pending_email}</strong>. Confirm both
                    inbox messages to finish.
                  </p>
                )}
                <div>
                  <label htmlFor="account-new-email" className="field-label">
                    New email address
                  </label>
                  <input
                    id="account-new-email"
                    className="input"
                    name="new_email"
                    type="email"
                    maxLength={254}
                    autoComplete="email"
                    disabled={pending}
                    required
                  />
                </div>
                {mfa && (
                  <div>
                    <label htmlFor="email-mfa-code" className="field-label">
                      Authenticator code
                    </label>
                    <input
                      id="email-mfa-code"
                      name="mfa_code"
                      className="input"
                      inputMode="numeric"
                      pattern="[0-9]{6}"
                      autoComplete="one-time-code"
                      required
                      disabled={pending}
                    />
                  </div>
                )}
                <p className="text-xs leading-6 text-stone-600">
                  Changing your Vidyalayaa email does not change your Google account. Existing
                  Google sign-in remains linked to this account.
                </p>
                <Button variant="lime" disabled={pending || !state.data.email_confirmed}>
                  <Mail size={16} />
                  Send verification emails
                </Button>
              </form>
            </Panel>
            <Panel
              title={state.data.has_password ? 'Change password' : 'Set password'}
              subtitle={
                state.data.has_password
                  ? 'Confirm your identity before choosing a new password.'
                  : 'Add a password to the same account you use with Google.'
              }
            >
              {state.data.has_password ? (
                <form
                  className="space-y-5 p-6"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = event.currentTarget;
                    const fields = new FormData(form);
                    void action(async () => {
                      if (fields.get('password') !== fields.get('confirmation'))
                        throw new Error('The passwords do not match.');
                      await confirmAccountAssurance(id, String(fields.get('mfa_code') || ''));
                      await updateOwnAccount(id, {
                        current_password: String(fields.get('current_password')),
                        password: String(fields.get('password')),
                        ...(fields.get('nonce')
                          ? { nonce: String(fields.get('nonce')).trim() }
                          : {}),
                      });
                      form.reset();
                      setNonceSent(false);
                      return 'Your password has been changed. Your Google sign-in is still connected.';
                    });
                  }}
                >
                  <div>
                    <label htmlFor="account-current-password" className="field-label">
                      Current password
                    </label>
                    <input
                      id="account-current-password"
                      name="current_password"
                      className="input"
                      type="password"
                      autoComplete="current-password"
                      disabled={pending}
                      required
                    />
                  </div>
                  <div>
                    <label htmlFor="account-new-password" className="field-label">
                      New password
                    </label>
                    <input
                      id="account-new-password"
                      name="password"
                      className="input"
                      type="password"
                      minLength={12}
                      maxLength={128}
                      autoComplete="new-password"
                      disabled={pending}
                      required
                    />
                  </div>
                  <div>
                    <label htmlFor="account-confirm-password" className="field-label">
                      Confirm new password
                    </label>
                    <input
                      id="account-confirm-password"
                      name="confirmation"
                      className="input"
                      type="password"
                      minLength={12}
                      maxLength={128}
                      autoComplete="new-password"
                      disabled={pending}
                      required
                    />
                  </div>
                  <p className="text-xs text-stone-600">
                    Use at least 12 characters. Older sign-ins may also need an email verification
                    code.
                  </p>
                  {nonceSent && (
                    <div>
                      <label htmlFor="account-nonce" className="field-label">
                        Email verification code
                      </label>
                      <input
                        id="account-nonce"
                        name="nonce"
                        className="input"
                        inputMode="numeric"
                        pattern="[0-9]{6,10}"
                        autoComplete="one-time-code"
                        disabled={pending}
                        required
                      />
                    </div>
                  )}
                  {mfa && (
                    <div>
                      <label htmlFor="password-mfa-code" className="field-label">
                        Authenticator code
                      </label>
                      <input
                        id="password-mfa-code"
                        name="mfa_code"
                        className="input"
                        inputMode="numeric"
                        pattern="[0-9]{6}"
                        autoComplete="one-time-code"
                        required
                        disabled={pending}
                      />
                    </div>
                  )}
                  <div className="flex flex-wrap gap-3">
                    <Button variant="lime" disabled={pending}>
                      <KeyRound size={16} />
                      Change password
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        void action(async () => {
                          await assertAccountIdentity(id);
                          const result = await supabase!.auth.reauthenticate();
                          if (result.error) throw result.error;
                          setNonceSent(true);
                          return 'A verification code has been requested for your current email address.';
                        })
                      }
                    >
                      Send verification code
                    </Button>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={sendPasswordSetup}
                  >
                    Forgot your current password? Send a reset link
                  </Button>
                </form>
              ) : (
                <div className="space-y-5 p-6">
                  <div className="inline-flex rounded-xl bg-lime-100 p-3">
                    <KeyRound size={25} />
                  </div>
                  <p className="text-sm leading-7 text-stone-600">
                    We’ll send a secure link to your verified email. Open it to create a password
                    without creating a new account or disconnecting Google.
                  </p>
                  <Button
                    variant="lime"
                    disabled={pending || !state.data.email_confirmed}
                    onClick={sendPasswordSetup}
                  >
                    Send password setup link
                  </Button>
                </div>
              )}
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
