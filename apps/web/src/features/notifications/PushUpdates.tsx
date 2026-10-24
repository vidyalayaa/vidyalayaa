import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { schoolPath } from '../../lib/portals';
import { Button } from '../../components/ui/button';
export default function PushUpdates() {
  const a = useAuth(),
    qc = useQueryClient(),
    [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    if (!('serviceWorker' in navigator) || !a.me?.school) return;
    const receive = (event: MessageEvent) => {
      if (
        event.data?.type !== 'VIDYALAYAA_SCHOOL_UPDATE' ||
        event.data.school_id !== a.me?.school?.school_id
      )
        return;
      setReady(true);
      void qc.invalidateQueries({
        predicate: (q) =>
          q.queryKey[0] === a.school && String(q.queryKey[1]).startsWith('notification-'),
      });
    };
    navigator.serviceWorker.addEventListener('message', receive);
    return () => navigator.serviceWorker.removeEventListener('message', receive);
  }, [a.school, a.me?.school?.school_id, qc]);
  return ready && a.me?.school ? (
    <div className="notice mb-4 flex flex-wrap items-center gap-3" role="status">
      <span>A new school update is available.</span>
      <Link
        className="underline"
        to={schoolPath('/notifications', a.me.school.role)}
        onClick={() => setReady(false)}
      >
        View notifications
      </Link>
      <Button size="sm" variant="ghost" onClick={() => setReady(false)}>
        Dismiss
      </Button>
    </div>
  ) : null;
}
