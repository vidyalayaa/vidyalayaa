import { useRef, useState } from 'react';
import { supabase } from '../../lib/auth';
import { Button } from '../../components/ui/button';
import AuthChallenge, { authChallengeEnabled } from './AuthChallenge';
import { authRateLimited, type useAuthEmailCooldown } from './auth-limits';

export default function EmailSignIn({
  cooldown,
  onVerified,
}: {
  cooldown: ReturnType<typeof useAuthEmailCooldown>;
  onVerified: () => Promise<void>;
}) {
  const busy = useRef(false);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string>();
  const [challenge, setChallenge] = useState(0);
  async function send() {
    const result = await supabase!.auth.signInWithOtp({
      email: email.trim(),
      options: {
        shouldCreateUser: false,
        captchaToken,
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
    cooldown.start();
    setSent(true);
  }
  return (
    <details
      className="my-5 rounded-xl border border-stone-200 p-4"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        if (!event.currentTarget.open) setCaptchaToken(undefined);
      }}
    >
      <summary className="cursor-pointer text-sm font-semibold">
        Sign in with an email link or code
      </summary>
      <form
        className="mt-5 space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!supabase || busy.current) return;
          if ((authChallengeEnabled && !captchaToken) || (!sent && cooldown.seconds)) return;
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
              if (authRateLimited(result.error)) throw result.error;
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
            if (authRateLimited(cause)) {
              if (!sent) cooldown.start();
              setError('Too many attempts. Wait before trying again.');
            } else setError((cause as Error).message);
          } finally {
            setCaptchaToken(undefined);
            setChallenge((value) => value + 1);
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
              if (sent) {
                setCaptchaToken(undefined);
                setChallenge((value) => value + 1);
              }
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
        {open && <AuthChallenge key={challenge} onToken={setCaptchaToken} />}
        <Button
          variant="outline"
          disabled={
            pending ||
            !supabase ||
            (authChallengeEnabled && !captchaToken) ||
            (!sent && cooldown.seconds > 0)
          }
        >
          {pending ? 'Please wait…' : sent ? 'Verify sign-in code' : 'Send sign-in email'}
        </Button>
        {cooldown.seconds > 0 && (
          <p className="text-xs" role="status">
            You can request another email in {cooldown.seconds}s.
          </p>
        )}
        {sent && (
          <button
            type="button"
            className="ml-3 text-xs underline disabled:opacity-60"
            disabled={pending || cooldown.seconds > 0}
            onClick={() => {
              setSent(false);
              setError('');
              setCaptchaToken(undefined);
              setChallenge((value) => value + 1);
            }}
          >
            Request a new email
          </button>
        )}
        <p className="text-xs text-stone-600">
          School access still requires an invitation and your assigned role.
        </p>
      </form>
    </details>
  );
}
