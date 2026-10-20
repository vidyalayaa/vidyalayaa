import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, useAuth } from '../../lib/auth';
import { Panel, Loading, ErrorState } from '../../components/common';
import { Button } from '../../components/ui/button';
export default function NotificationPrivacy() {
  const a = useAuth(),
    qc = useQueryClient(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [desired, setDesired] = useState<boolean | undefined>();
  const query = useQuery({
    queryKey: [a.school, 'notification-privacy'],
    queryFn: () => api<{ no_names_on_lock_screen: boolean }>('/profile/preferences'),
  });
  async function change(value: boolean) {
    setDesired(value);
    setBusy(true);
    setError('');
    try {
      await api('/profile/preferences', {
        method: 'PUT',
        body: JSON.stringify({ no_names_on_lock_screen: value }),
      });
      await qc.invalidateQueries({ queryKey: [a.school, 'notification-privacy'] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDesired(undefined);
      setBusy(false);
    }
  }
  return (
    <Panel
      title="Notification privacy"
      subtitle="Choose what appears on your device’s lock screen."
    >
      <div className="settings-body">
        {query.isLoading ? (
          <Loading />
        ) : query.error ? (
          <ErrorState error={query.error} retry={() => query.refetch()} />
        ) : (
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={desired ?? query.data?.no_names_on_lock_screen ?? true}
              disabled={busy}
              onChange={(e) => change(e.target.checked)}
            />
            <span>
              Hide school update details on the lock screen. Open Vidyalayaa to read the full
              update.
            </span>
          </label>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <Button
          className="mt-4"
          variant="outline"
          disabled={busy}
          onClick={() =>
            import('../../lib/push').then((m) => m.disablePush()).catch((e) => setError(e.message))
          }
        >
          Disable notifications on this browser
        </Button>
      </div>
    </Panel>
  );
}
