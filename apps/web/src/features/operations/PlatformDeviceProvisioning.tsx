import { useEffect, useState, type FormEvent } from 'react';
import { Dialog } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { api } from '../../lib/auth';

type Settings = { api_origin: string; root_ca: string };

export default function PlatformDeviceProvisioning({ close }: { close: () => void }) {
  const [origin, setOrigin] = useState('');
  const [certificate, setCertificate] = useState('');
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const request = new AbortController();
    void api<Settings | null>('/platform/device-provisioning', { signal: request.signal })
      .then((settings) => {
        if (request.signal.aborted) return;
        setOrigin(settings?.api_origin || import.meta.env.VITE_API_URL || '');
        setCertificate(settings?.root_ca || '');
        setReady(true);
      })
      .catch((failure: Error) => {
        if (!request.signal.aborted) setError(failure.message);
      });
    return () => request.abort();
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      await api('/platform/device-provisioning', {
        method: 'PUT',
        body: JSON.stringify({ api_origin: origin, root_ca: certificate }),
      });
      setSaved(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to save device settings.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      title="Device provisioning"
      size="compact"
      dismissible={!saving}
      onOpenChange={(open) => {
        if (!open && !saving) close();
      }}
      description="Choose the API and trusted root certificate for all schools. The next USB setup applies these settings to the reader."
    >
      <form className="space-y-4" onSubmit={save}>
        <label className="block">
          <span className="field-label">HTTPS API address</span>
          <input
            className="input"
            type="url"
            value={origin}
            required
            disabled={!ready || saving}
            onChange={(event) => {
              setOrigin(event.target.value);
              setSaved(false);
            }}
          />
        </label>
        <label className="block">
          <span className="field-label">Trusted root certificate (PEM)</span>
          <textarea
            className="input min-h-36 font-mono"
            value={certificate}
            required
            disabled={!ready || saving}
            onChange={(event) => {
              setCertificate(event.target.value);
              setSaved(false);
            }}
          />
        </label>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        {saved && (
          <p className="text-sm" role="status">
            Device provisioning settings saved.
          </p>
        )}
        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={close} disabled={saving}>
            Close
          </Button>
          <Button type="submit" variant="lime" disabled={!ready || saving}>
            {saving ? 'Saving…' : 'Save settings'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
