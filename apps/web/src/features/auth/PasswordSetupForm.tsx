import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AccountMfaRequired,
  confirmAccountAssurance,
  discardAuthAction,
  updateOwnAccount,
} from '../../lib/auth';
import { Button } from '../../components/ui/button';

export default function PasswordSetupForm({
  identity,
  invalidate,
}: {
  identity: { id: string; email?: string };
  invalidate: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [needsMfa, setNeedsMfa] = useState(false);
  const submitting = useRef(false);
  const navigate = useNavigate();
  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (submitting.current) return;
        const form = event.currentTarget;
        const fields = new FormData(form);
        const password = String(fields.get('password'));
        if (password !== String(fields.get('confirmation'))) {
          setError('The passwords do not match.');
          return;
        }
        submitting.current = true;
        setPending(true);
        setError('');
        try {
          await confirmAccountAssurance(identity.id, String(fields.get('mfa_code') || ''));
          await updateOwnAccount(identity.id, { password });
          discardAuthAction();
          form.reset();
          navigate('/settings', { replace: true });
        } catch (cause) {
          const message = (cause as Error).message;
          if (cause instanceof AccountMfaRequired) setNeedsMfa(true);
          if (/sign-in changed|Sign in again/.test(message)) {
            invalidate();
          }
          setError(message);
        } finally {
          submitting.current = false;
          setPending(false);
        }
      }}
    >
      <div>
        <label className="field-label" htmlFor="new-password">
          New password
        </label>
        <input
          id="new-password"
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
        <label className="field-label" htmlFor="confirm-password">
          Confirm password
        </label>
        <input
          id="confirm-password"
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
        Use at least 12 characters. Your existing Google sign-in remains connected.
      </p>
      {needsMfa && (
        <div>
          <label className="field-label" htmlFor="setup-mfa-code">
            Authenticator code
          </label>
          <input
            id="setup-mfa-code"
            name="mfa_code"
            className="input"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            required
            disabled={pending}
          />
        </div>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <Button variant="lime" disabled={pending}>
        {pending ? 'Saving your password…' : 'Set password & continue'}
      </Button>
    </form>
  );
}
