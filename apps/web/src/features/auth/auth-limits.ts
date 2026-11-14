import { useEffect, useState } from 'react';

export function authRateLimited(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    (('status' in error && error.status === 429) ||
      ('code' in error &&
        ['over_email_send_rate_limit', 'over_request_rate_limit'].includes(String(error.code))))
  );
}

const cooldownKey = 'vidyalayaa.auth-email-cooldown';
const remaining = () =>
  Math.max(0, Math.ceil((Number(sessionStorage.getItem(cooldownKey) || 0) - Date.now()) / 1000));

export function useAuthEmailCooldown() {
  const [seconds, setSeconds] = useState(remaining);
  const coolingDown = seconds > 0;
  useEffect(() => {
    if (!coolingDown) return;
    const timer = window.setInterval(() => setSeconds(remaining()), 1000);
    return () => window.clearInterval(timer);
  }, [coolingDown]);
  return {
    seconds,
    start: () => {
      sessionStorage.setItem(cooldownKey, String(Date.now() + 60000));
      setSeconds(60);
    },
  };
}
