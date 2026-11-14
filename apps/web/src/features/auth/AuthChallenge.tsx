import { useEffect, useRef, useState } from 'react';
import { useTheme } from '../../lib/theme';

const sitekey = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim();
const scriptUrl = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

type Turnstile = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      theme: 'light' | 'dark' | 'auto';
      appearance: 'always';
      size: 'flexible';
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback': () => void;
    },
  ) => string;
  remove: (id: string) => void;
};

let loading: Promise<Turnstile> | undefined;
function loadTurnstile() {
  return (loading ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = scriptUrl;
    script.async = true;
    const fail = () => {
      window.clearTimeout(timeout);
      script.remove();
      reject(new Error('Turnstile could not load.'));
    };
    const timeout = window.setTimeout(fail, 15000);
    script.onerror = fail;
    script.onload = () => {
      const api = (window as Window & { turnstile?: Turnstile }).turnstile;
      if (!api) return fail();
      window.clearTimeout(timeout);
      resolve(api);
    };
    document.head.append(script);
  }).catch((cause) => {
    loading = undefined;
    throw cause;
  }));
}

export const authChallengeEnabled = Boolean(sitekey);

export default function AuthChallenge({
  onToken,
}: {
  onToken: (token: string | undefined) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const { mode } = useTheme();
  useEffect(() => {
    if (!sitekey) return;
    const key = sitekey;
    let disposed = false;
    let widget: { api: Turnstile; id: string } | undefined;
    onToken(undefined);
    setFailed(false);
    const fail = () => {
      if (disposed) return;
      onToken(undefined);
      setFailed(true);
    };
    void loadTurnstile()
      .then((api) => {
        if (disposed || !host.current) return;
        const id = api.render(host.current, {
          sitekey: key,
          theme: mode === 'system' ? 'auto' : mode,
          appearance: 'always',
          size: 'flexible',
          callback: (token) => {
            if (disposed) return;
            onToken(token);
            setFailed(false);
          },
          'expired-callback': () => {
            if (disposed) return;
            onToken(undefined);
            setAttempt((value) => value + 1);
          },
          'error-callback': fail,
        });
        widget = { api, id };
      })
      .catch(fail);
    return () => {
      disposed = true;
      if (widget) widget.api.remove(widget.id);
    };
  }, [attempt, onToken, mode]);
  if (!sitekey) return null;
  return (
    <div>
      <div ref={host} />
      {failed && (
        <p className="field-error mt-2" role="alert">
          Security check unavailable.{' '}
          <button
            type="button"
            className="underline"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry security check
          </button>
        </p>
      )}
    </div>
  );
}
