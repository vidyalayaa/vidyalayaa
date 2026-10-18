import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  ArrowUpRight,
  CheckCheck,
  Radio,
  ShieldCheck,
  GraduationCap,
} from 'lucide-react';
import { configured, supabase } from '../../lib/auth';
import { Button } from '../../components/ui/button';
export default function Login() {
  const navigate = useNavigate(),
    [params] = useSearchParams(),
    [recovery, setRecovery] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [pending, setPending] = useState(false),
    [factor, setFactor] = useState('');
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
            {factor
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
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setError('');
              setMessage('');
              if (!supabase) return;
              setPending(true);
              const f = new FormData(e.currentTarget);
              try {
                if (factor) {
                  const r = await supabase.auth.mfa.challengeAndVerify({
                    factorId: factor,
                    code: String(f.get('code')),
                  });
                  if (r.error) throw r.error;
                  navigate('/');
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
                  const factors = await supabase.auth.mfa.listFactors();
                  const verified = factors.data?.totp.find((x) => x.status === 'verified');
                  if (verified) setFactor(verified.id);
                  else {
                    const to = params.get('returnTo');
                    navigate(to?.startsWith('/') && !to.startsWith('//') ? to : '/');
                  }
                }
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setPending(false);
              }
            }}
          >
            {factor ? (
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
            <Button className="mt-6 w-full" variant="lime" disabled={pending || !configured}>
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
export function AuthCallback() {
  const [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    navigate = useNavigate();
  return (
    <div className="callback-page">
      <div className="panel p-8">
        <h1 className="text-2xl font-semibold">Make yourself at home.</h1>
        <p className="my-3 text-sm text-stone-500">
          Set a new password to finish your invitation or recovery.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const password = String(new FormData(e.currentTarget).get('password'));
            if (!supabase) return;
            const r = await supabase.auth.updateUser({ password });
            if (r.error) setError(r.error.message);
            else {
              setMessage('Password updated.');
              navigate('/');
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
            required
          />
          <Button className="mt-4" variant="lime">
            Set password & continue
          </Button>
        </form>
        {message && <p role="status">{message}</p>}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
