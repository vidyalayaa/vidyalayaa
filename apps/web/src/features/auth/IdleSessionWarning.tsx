import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';

const warningMs = 60_000;

export function IdleSessionWarning({
  deadline,
  extend,
  checkExpiry,
}: {
  deadline: string;
  extend: () => Promise<void>;
  checkExpiry: () => Promise<void>;
}) {
  const endsAt = Date.parse(deadline);
  const [seconds, setSeconds] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const lastActivity = useRef(0);
  const passiveRequest = useRef(false);

  useEffect(() => {
    if (!Number.isFinite(endsAt)) return;
    let timer: number;
    let checking = false;
    let active = true;
    const tick = () => {
      clearTimeout(timer);
      if (checking) return;
      const left = endsAt - Date.now();
      setSeconds(left > warningMs ? null : Math.max(0, Math.ceil(left / 1000)));
      if (left > warningMs) {
        timer = window.setTimeout(tick, left - warningMs);
      } else if (left > 0) {
        timer = window.setTimeout(tick, left % 1000 || 1000);
      } else {
        checking = true;
        void checkExpiry()
          .catch(() => {})
          .finally(() => {
            checking = false;
            if (active) timer = window.setTimeout(tick, 1000);
          });
      }
    };
    tick();
    document.addEventListener('visibilitychange', tick);
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [endsAt, checkExpiry]);

  useEffect(() => {
    const interact = (event: Event) => {
      const now = Date.now();
      if (
        !event.isTrusted ||
        document.visibilityState !== 'visible' ||
        endsAt - now <= warningMs ||
        now - lastActivity.current < 30_000 ||
        passiveRequest.current
      )
        return;
      lastActivity.current = now;
      passiveRequest.current = true;
      void extend()
        .catch(() => {})
        .finally(() => {
          passiveRequest.current = false;
        });
    };
    document.addEventListener('pointerdown', interact);
    document.addEventListener('keydown', interact);
    return () => {
      document.removeEventListener('pointerdown', interact);
      document.removeEventListener('keydown', interact);
    };
  }, [endsAt, extend]);

  async function staySignedIn() {
    setPending(true);
    setError('');
    try {
      await extend();
    } catch {
      setError('Could not extend your session. Try again before the countdown ends.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={seconds !== null}
      onOpenChange={() => {}}
      dismissible={false}
      title="You’re about to be signed out"
      description="Your session is idle. Select Cancel to stay signed in."
    >
      <p role="timer" aria-live="off" className="mb-4 text-2xl font-semibold tabular-nums">
        {seconds === null
          ? null
          : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}
        <span className="ml-2 text-sm font-medium text-stone-600">until sign-out</span>
      </p>
      {error && seconds !== 0 && (
        <p className="field-error mb-4" role="alert">
          {error}
        </p>
      )}
      <Button
        type="button"
        variant="lime"
        onClick={() => void staySignedIn()}
        disabled={pending || seconds === 0}
      >
        {seconds === 0 ? 'Signing out…' : pending ? 'Staying signed in…' : 'Cancel'}
      </Button>
    </Dialog>
  );
}
