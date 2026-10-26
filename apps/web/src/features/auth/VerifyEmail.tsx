import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { completeAccountVerification, discardAuthAction, useAuth } from '../../lib/auth';
import { Button } from '../../components/ui/button';
import PasswordSetupForm from './PasswordSetupForm';

export default function VerifyEmail() {
  const auth = useAuth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Awaited<
    ReturnType<typeof completeAccountVerification>
  > | null>(null);
  return (
    <main className="callback-page">
      <section className="panel p-7 sm:p-9" aria-labelledby="verification-title">
        <div className="mb-6 inline-flex rounded-xl bg-lime-100 p-3 text-lime-900">
          <ShieldCheck size={26} />
        </div>
        <h1 id="verification-title" className="text-2xl font-semibold">
          {result?.kind === 'password'
            ? 'Choose your Vidyalayaa password.'
            : result
              ? 'Email verification received.'
              : 'Continue securely.'}
        </h1>
        <p className="my-4 text-sm leading-7 text-stone-600">
          {result?.kind === 'password'
            ? `Set a password for ${result.identity?.email || 'your verified account'}.`
            : result?.kind === 'email_change'
              ? 'Your confirmation has been received. If your address has not changed yet, also confirm the message sent to your other email address.'
              : result
                ? 'Your email has been verified. Continue to sign in and complete any required authenticator check.'
                : 'Only continue if you requested this email or recognize your school invitation. This link can sign you into the account named in the email. Visiting this page alone does not use the link.'}
        </p>
        {!result && !error && (
          <Button
            variant="lime"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              try {
                setResult(await completeAccountVerification());
                auth.refetch();
              } catch (cause) {
                setError((cause as Error).message);
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? 'Verifying…' : 'Confirm and continue'}
            <ArrowRight size={16} />
          </Button>
        )}
        {result?.kind === 'password' && result.identity && (
          <PasswordSetupForm
            identity={result.identity}
            invalidate={() => {
              setResult(null);
              setError(
                'Your sign-in changed. Request a new setup link before choosing a password.',
              );
            }}
          />
        )}
        {result && result.kind !== 'password' && (
          <Button asChild variant="lime">
            <Link
              onClick={discardAuthAction}
              to={result.kind === 'email_change' ? '/settings/account' : '/login?mfa=1'}
            >
              Continue to your account
              <ArrowRight size={16} />
            </Link>
          </Button>
        )}
        {error && (
          <>
            <p className="field-error my-4" role="alert">
              {error}
            </p>
            <Button asChild variant="outline">
              <Link to="/login?recovery=1">Request a new setup link</Link>
            </Button>
          </>
        )}
      </section>
    </main>
  );
}
