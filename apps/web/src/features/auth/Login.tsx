import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  ArrowUpRight,
  CheckCheck,
  Radio,
  ShieldCheck,
  GraduationCap,
} from 'lucide-react';
import {
  completePasswordSetup,
  completeGoogleSignIn,
  startGoogleSignIn,
  getSignInFactor,
  configured,
  supabase,
  useAuth,
} from '../../lib/auth';
import { safeReturnTo } from '../../lib/auth-return';
import { Button } from '../../components/ui/button';
export default function Login() {
  const navigate = useNavigate(),
    [params] = useSearchParams(),
    [recovery, setRecovery] = useState(params.get('recovery') === '1'),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [pending, setPending] = useState(false),
    [factor, setFactor] = useState(''),
    [checkingMfa, setCheckingMfa] = useState(params.get('mfa') === '1');
  const submitting = useRef(false);
  const auth = useAuth();
  const mfaRequested = params.get('mfa') === '1';
  const returnTo = safeReturnTo(params.get('returnTo'));
  useEffect(() => {
    if (!mfaRequested) return;
    let ignore = false;
    getSignInFactor()
      .then((id) => {
        if (ignore) return;
        if (id) setFactor(id);
        else navigate(returnTo, { replace: true });
      })
      .catch((cause: Error) => {
        if (!ignore) setError(cause.message);
      })
      .finally(() => {
        if (!ignore) setCheckingMfa(false);
      });
    return () => {
      ignore = true;
    };
  }, [mfaRequested, navigate, returnTo]);
  return (
    <div className="login-page">
      <section className="login-story">
        <Link to="/" className="brand">
          <span className="brand-symbol">
            v<span />
          </span>
          <span>vidyalayaa.</span>
        </Link>
        <div className="login-story-copy">
          <span className="tiny-pill">
            <GraduationCap size={14} />
            FOR THE PEOPLE WHO MAKE A SCHOOL
          </span>
          <h1>
            Less scattered.
            <br />
            More connected.
          </h1>
          <p>
            A thoughtful home for your school’s everyday.
            <br />
            Students, staff, and families. Together.
          </p>
          <div className="login-benefits">
            <span>
              <CheckCheck size={19} />
              Every school day, accounted for.
            </span>
            <span>
              <Radio size={19} />
              Every campus, connected.
            </span>
            <span>
              <ShieldCheck size={19} />
              Every record, protected.
            </span>
          </div>
        </div>
        <p className="login-footer">A connected school. A calmer day.</p>
        <div className="login-decoration" aria-hidden="true">
          <i />
          <i />
          <i />
          <span>v.</span>
        </div>
      </section>
      <section className="login-form-area">
        <Link to="/" className="login-back">
          Back to workspace <ArrowUpRight size={14} />
        </Link>
        <div className="login-form-box">
          <span className="eyebrow">YOUR SCHOOL, IN SYNC</span>
          <h2>
            {checkingMfa
              ? 'Checking account security…'
              : factor
                ? 'One more secure step.'
                : recovery
                  ? 'Let’s get you back in.'
                  : 'Good to see you.'}
          </h2>
          <p>
            {factor
              ? 'Enter the code from your authenticator app.'
              : recovery
                ? 'We’ll send a secure link to reset your password.'
                : 'Sign in to your Vidyalayaa workspace.'}
          </p>
          {!configured && (
            <div className="notice">
              Workspace setup is required before signing in. Your deployment guide includes the
              connection steps.
            </div>
          )}
          {!factor && !recovery && !checkingMfa && (
            <>
              <Button
                type="button"
                variant="outline"
                className="mt-6 w-full"
                disabled={pending || !configured}
                onClick={async () => {
                  if (submitting.current) return;
                  submitting.current = true;
                  setPending(true);
                  setError('');
                  setMessage('');
                  try {
                    await startGoogleSignIn(returnTo);
                  } catch (cause) {
                    setError((cause as Error).message);
                    setPending(false);
                    submitting.current = false;
                  }
                }}
              >
                <svg aria-hidden="true" viewBox="0 0 48 48" className="size-5">
                  <path
                    fill="#4285F4"
                    d="M43.61 24.46c0-1.36-.12-2.66-.35-3.92H24v7.42h11a9.4 9.4 0 0 1-4.08 6.18v5.14h6.61c3.86-3.56 6.08-8.8 6.08-14.82Z"
                  />
                  <path
                    fill="#34A853"
                    d="M24 44c5.5 0 10.1-1.83 13.47-4.72l-6.61-5.14c-1.83 1.22-4.17 1.96-6.86 1.96-5.3 0-9.79-3.58-11.4-8.4H5.78v5.3A20 20 0 0 0 24 44Z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M12.6 27.7a12 12 0 0 1 0-7.4V15H5.78a20 20 0 0 0 0 18l6.82-5.3Z"
                  />
                  <path
                    fill="#EA4335"
                    d="M24 11.9c3 0 5.7 1.03 7.82 3.06l5.87-5.87C34.13 5.77 29.5 4 24 4A20 20 0 0 0 5.78 15l6.82 5.3c1.61-4.82 6.1-8.4 11.4-8.4Z"
                  />
                </svg>
                Continue with Google
              </Button>
              <div className="my-5 flex items-center gap-3 text-xs text-stone-500">
                <span className="h-px flex-1 bg-stone-200" />
                Or sign in with email
                <span className="h-px flex-1 bg-stone-200" />
              </div>
            </>
          )}
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setError('');
              setMessage('');
              if (!supabase || submitting.current || checkingMfa) return;
              submitting.current = true;
              setPending(true);
              const f = new FormData(e.currentTarget);
              try {
                if (factor) {
                  const r = await supabase.auth.mfa.challengeAndVerify({
                    factorId: factor,
                    code: String(f.get('code')),
                  });
                  if (r.error) throw r.error;
                  navigate(returnTo, { replace: true });
                } else if (recovery) {
                  const r = await supabase.auth.resetPasswordForEmail(String(f.get('email')), {
                    redirectTo: location.origin + '/auth/callback',
                  });
                  if (r.error) throw r.error;
                  setMessage('If this account exists, a recovery link has been sent.');
                } else {
                  const r = await supabase.auth.signInWithPassword({
                    email: String(f.get('email')),
                    password: String(f.get('password')),
                  });
                  if (r.error) throw r.error;
                  const id = await getSignInFactor();
                  if (id) setFactor(id);
                  else navigate(returnTo, { replace: true });
                }
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setPending(false);
                submitting.current = false;
              }
            }}
          >
            {checkingMfa ? (
              <p role="status">Checking your authenticator settings…</p>
            ) : factor ? (
              <div>
                <label className="field-label" htmlFor="code">
                  Authentication code
                </label>
                <input
                  id="code"
                  name="code"
                  className="input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  required
                />
              </div>
            ) : (
              <>
                <label className="field-label" htmlFor="email">
                  Email address
                </label>
                <input
                  className="input"
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  placeholder="you@yourschool.edu"
                  required
                />
                {!recovery && (
                  <>
                    <div className="mt-5 flex justify-between">
                      <label className="field-label" htmlFor="password">
                        Password
                      </label>
                      <button
                        type="button"
                        className="text-xs underline"
                        onClick={() => setRecovery(true)}
                      >
                        Forgot password?
                      </button>
                    </div>
                    <input
                      className="input"
                      id="password"
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      placeholder="Enter your password"
                      required
                    />
                  </>
                )}
              </>
            )}
            {error && (
              <p className="field-error mt-4" role="alert">
                {error}
              </p>
            )}
            {message && (
              <p className="mt-4 text-sm text-green-800" role="status">
                {message}
              </p>
            )}
            <Button
              className="mt-6 w-full"
              variant="lime"
              disabled={pending || checkingMfa || !configured}
            >
              {pending
                ? 'Please wait…'
                : factor
                  ? 'Verify & continue'
                  : recovery
                    ? 'Send recovery link'
                    : 'Sign in'}
              <ArrowRight size={16} />
            </Button>
          </form>
          {factor && (
            <button
              type="button"
              className="mt-5 text-sm underline"
              disabled={pending}
              onClick={async () => {
                await auth.logout();
                navigate('/login', { replace: true });
                setFactor('');
              }}
            >
              Use a different account
            </button>
          )}
          {recovery && (
            <button className="mt-5 text-sm underline" onClick={() => setRecovery(false)}>
              Back to sign in
            </button>
          )}
          <p className="login-help">
            Need an account? Contact your school administrator.
            <br />
            <a href="mailto:vidyalayaainfo@gmail.com">
              Get help with Vidyalayaa <ArrowUpRight size={13} />
            </a>
          </p>
          <p className="secure-note">
            <ShieldCheck size={14} />
            Your school. Your data. Securely connected.
          </p>
        </div>
      </section>
    </div>
  );
}
export function GoogleCallback() {
  const [error, setError] = useState('');
  const navigate = useNavigate();
  useEffect(() => {
    let ignore = false;
    completeGoogleSignIn()
      .then((returnTo) => {
        if (!ignore)
          navigate(`/login?mfa=1&returnTo=${encodeURIComponent(returnTo)}`, { replace: true });
      })
      .catch((cause: Error) => {
        if (!ignore) setError(cause.message);
      });
    return () => {
      ignore = true;
    };
  }, [navigate]);
  return (
    <div className="callback-page">
      <div className="panel p-8">
        <h1 className="text-2xl font-semibold">
          {error ? 'Google sign-in needs another try.' : 'Completing Google sign-in…'}
        </h1>
        {error ? (
          <>
            <p className="field-error my-4" role="alert">
              {error}
            </p>
            <Button asChild variant="lime">
              <Link to="/login">Back to sign in</Link>
            </Button>
          </>
        ) : (
          <p className="mt-3 text-sm text-stone-600" role="status">
            Please wait while we verify your account.
          </p>
        )}
      </div>
    </div>
  );
}
export function AuthCallback() {
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(true);
  const [pending, setPending] = useState(false);
  const [identity, setIdentity] = useState<{ id: string; email?: string } | null>(null);
  const submitting = useRef(false);
  const navigate = useNavigate();
  useEffect(() => {
    let ignore = false;
    completePasswordSetup()
      .then((account) => {
        if (!ignore) setIdentity(account);
      })
      .catch((cause: Error) => {
        if (!ignore) setError(cause.message);
      })
      .finally(() => {
        if (!ignore) setChecking(false);
      });
    return () => {
      ignore = true;
    };
  }, []);
  return (
    <div className="callback-page">
      <div className="panel p-8">
        <h1 className="text-2xl font-semibold">
          {checking
            ? 'Checking your setup link…'
            : identity
              ? 'Make yourself at home.'
              : 'Request a fresh setup link.'}
        </h1>
        <p className="my-3 text-sm text-stone-500">
          {checking
            ? 'Please wait while we verify your account.'
            : identity
              ? `Choose your Vidyalayaa password for ${identity.email || 'your account'}.`
              : 'Use a new password setup email to continue securely.'}
        </p>
        {identity && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!supabase || submitting.current) return;
              const fields = new FormData(e.currentTarget);
              const password = String(fields.get('password'));
              if (password !== String(fields.get('confirmation'))) {
                setError('The passwords do not match.');
                return;
              }
              submitting.current = true;
              setPending(true);
              setError('');
              try {
                // A stale or rejected callback must never update a different account
                // that happens to be signed in in this browser.
                const current = await supabase.auth.getUser();
                if (current.error || current.data.user?.id !== identity.id) {
                  setIdentity(null);
                  throw new Error(
                    'Your sign-in changed. Request a new setup link before choosing a password.',
                  );
                }
                const result = await supabase.auth.updateUser({ password });
                if (result.error) throw result.error;
                navigate('/settings', { replace: true });
              } catch (cause) {
                setError((cause as Error).message);
              } finally {
                submitting.current = false;
                setPending(false);
              }
            }}
          >
            <label className="field-label" htmlFor="new-password">
              New password
            </label>
            <input
              id="new-password"
              name="password"
              className="input"
              type="password"
              minLength={12}
              autoComplete="new-password"
              disabled={pending}
              required
            />
            <label className="field-label mt-4" htmlFor="confirm-password">
              Confirm password
            </label>
            <input
              id="confirm-password"
              name="confirmation"
              className="input"
              type="password"
              minLength={12}
              autoComplete="new-password"
              disabled={pending}
              required
            />
            <Button className="mt-4" variant="lime" disabled={pending}>
              {pending ? 'Saving your password…' : 'Set password & continue'}
            </Button>
          </form>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        {!checking && !identity && (
          <Button asChild className="mt-4" variant="lime">
            <Link to="/login?recovery=1">Request a new setup link</Link>
          </Button>
        )}
      </div>
    </div>
  );
}
