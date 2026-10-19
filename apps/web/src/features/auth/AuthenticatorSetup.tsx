import { useEffect, useRef, useState, type FormEvent } from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { supabase, useAuth } from '../../lib/auth';
import { Button } from '../../components/ui/button';

const friendlyName = 'Vidyalayaa authenticator';
type Enrollment = { factorId: string; qrCode: string };

export default function AuthenticatorSetup() {
  const { session } = useAuth();
  const userId = session?.user.id;
  const [checking, setChecking] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [unfinished, setUnfinished] = useState(false);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A ref closes the window before React renders the disabled button.
  const operationInProgress = useRef(false);

  useEffect(() => {
    let ignore = false;
    setEnrollment(null);
    setEnabled(false);
    setUnfinished(false);
    setError('');
    setChecking(true);
    async function checkFactors() {
      try {
        if (!supabase || !userId) return;
        const result = await supabase.auth.mfa.listFactors();
        if (result.error) throw result.error;
        if (ignore) return;
        setEnabled(result.data.totp.length > 0);
        setUnfinished(
          result.data.all.some(
            (factor) =>
              factor.factor_type === 'totp' &&
              factor.status === 'unverified' &&
              factor.friendly_name === friendlyName,
          ),
        );
      } catch (cause) {
        if (!ignore) setError((cause as Error).message);
      } finally {
        if (!ignore) setChecking(false);
      }
    }
    void checkFactors();
    return () => {
      ignore = true;
    };
  }, [userId]);

  async function enroll() {
    if (!supabase || !session || operationInProgress.current || enrollment || enabled) return;
    operationInProgress.current = true;
    setBusy(true);
    setError('');
    try {
      // Read current server state again before changing any registration.
      const factors = await supabase.auth.mfa.listFactors();
      if (factors.error) throw factors.error;
      if (factors.data.totp.length > 0) {
        setEnabled(true);
        return;
      }
      // An interrupted setup cannot return its original QR secret. Replace only
      // this app's unfinished TOTP registration; never remove a verified factor.
      for (const factor of factors.data.all) {
        if (
          factor.factor_type === 'totp' &&
          factor.status === 'unverified' &&
          factor.friendly_name === friendlyName
        ) {
          const removed = await supabase.auth.mfa.unenroll({ factorId: factor.id });
          if (removed.error) throw removed.error;
        }
      }
      const result = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName });
      if (result.error) throw result.error;
      // The SDK already returns an SVG data URL ready for an image source.
      setEnrollment({ factorId: result.data.id, qrCode: result.data.totp.qr_code });
      setUnfinished(false);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      operationInProgress.current = false;
      setBusy(false);
    }
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !enrollment || operationInProgress.current) return;
    const code = String(new FormData(event.currentTarget).get('code'));
    operationInProgress.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await supabase.auth.mfa.challengeAndVerify({
        factorId: enrollment.factorId,
        code,
      });
      if (result.error) throw result.error;
      setEnabled(true);
      setEnrollment(null);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      operationInProgress.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="settings-body">
      <div className="security-heading">
        <span>
          <ShieldCheck size={25} />
        </span>
        <div>
          <h3>Multi-factor authentication</h3>
          <p>Protect your account with an authenticator app.</p>
        </div>
      </div>
      {enabled ? (
        <p className="text-sm text-green-800" role="status">
          Authenticator enabled.
        </p>
      ) : enrollment ? (
        <div className="mt-5">
          <img
            alt="Scan this QR code with your authenticator app"
            src={enrollment.qrCode}
            width={180}
            height={180}
          />
          <form className="mt-4 flex gap-2" onSubmit={verify}>
            <input
              name="code"
              aria-label="Authenticator code"
              className="input"
              pattern="[0-9]{6}"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              disabled={busy}
              required
            />
            <Button variant="lime" disabled={busy}>
              {busy ? 'Verifying…' : 'Verify'}
            </Button>
          </form>
        </div>
      ) : (
        <>
          {unfinished && (
            <p className="mb-4 text-sm text-stone-600">
              An earlier setup wasn’t finished. Continue to get a new QR code for your authenticator
              app.
            </p>
          )}
          <Button variant="outline" disabled={!session || checking || busy} onClick={enroll}>
            <KeyRound size={15} />
            {checking
              ? 'Checking authenticator…'
              : busy
                ? 'Preparing setup…'
                : unfinished
                  ? 'Continue authenticator setup'
                  : 'Set up authenticator'}
          </Button>
        </>
      )}
      {error && (
        <p className="field-error mt-3" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
