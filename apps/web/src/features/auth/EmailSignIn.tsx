import { useRef, useState } from 'react';
import { supabase } from '../../lib/auth';
import { Button } from '../../components/ui/button';

export default function EmailSignIn({ onVerified }: { onVerified: () => Promise<void> }) {
  const busy = useRef(false);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function send() {
    const result = await supabase!.auth.signInWithOtp({
      email: email.trim(),
      options: {
        shouldCreateUser: false,
        emailRedirectTo: location.origin + '/auth/verify',
      },
    });
    if (
      result.error &&
      !['user_not_found', 'signup_disabled', 'email_not_confirmed'].includes(
        result.error.code || '',
      )
    )
      throw result.error;
    setSent(true);
  }
  return (
    <details className="my-5 rounded-xl border border-stone-200 p-4">
      <summary className="cursor-pointer text-sm font-semibold">
        Sign in with an email link or code
      </summary>
      <form
        className="mt-5 space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!supabase || busy.current) return;
          busy.current = true;
          setPending(true);
          setError('');
          try {
            if (!sent) await send();
            else {
              const result = await supabase.auth.verifyOtp({
                email: email.trim(),
                token: String(new FormData(event.currentTarget).get('email_code')).trim(),
                type: 'email',
              });
              if (result.error || !result.data.session || !result.data.user)
                throw new Error(
                  'This code is invalid, expired, or already used. Request a new sign-in email.',
                );
              const verified = await supabase.auth.getUser(result.data.session.access_token);
              if (verified.error || verified.data.user?.id !== result.data.user.id)
                throw new Error('Your sign-in could not be verified. Please try again.');
              await onVerified();
            }
          } catch (cause) {
            setError((cause as Error).message);
          } finally {
            busy.current = false;
            setPending(false);
          }
        }}
      >
        <div>
          <label className="field-label" htmlFor="link-email">
            Email for sign-in link
          </label>
          <input
            id="link-email"
            className="input"
            type="email"
            value={email}
            autoComplete="email"
            required
            disabled={pending}
            onChange={(event) => {
              setEmail(event.target.value);
              setSent(false);
              setError('');
            }}
          />
        </div>
        {sent && (
          <>
            <p className="text-xs leading-6 text-stone-600" role="status">
              If this account is eligible, a sign-in email has been requested. Open its link or
              enter its one-time code below.
            </p>
            <div>
              <label className="field-label" htmlFor="email-signin-code">
                Email sign-in code
              </label>
              <input
                id="email-signin-code"
                name="email_code"
                className="input"
                inputMode="numeric"
                pattern="[0-9]{6,10}"
                autoComplete="one-time-code"
                required
                disabled={pending}
              />
            </div>
          </>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <Button variant="outline" disabled={pending || !supabase}>
          {pending ? 'Please wait…' : sent ? 'Verify sign-in code' : 'Send sign-in email'}
        </Button>
        <p className="text-xs text-stone-600">
          School access still requires an invitation and your assigned role.
        </p>
      </form>
    </details>
  );
}
