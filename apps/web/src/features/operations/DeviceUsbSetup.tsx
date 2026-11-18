import { useState, type FormEvent } from 'react';
import { Dialog } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { api } from '../../lib/auth';
import { useNfcReader } from '../resources/use-nfc-reader';

function bytes(value: string) {
  return new TextEncoder().encode(value).length;
}

export default function DeviceUsbSetup({
  device,
  close,
}: {
  device: Record<string, unknown>;
  close: () => void;
}) {
  const usb = useNfcReader('setup');
  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const setupMode = usb.diagnostics.includes('mode=enrollment');
  const code = String(device.device_code);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    setSaved(false);
    if (
      !bytes(ssid) ||
      bytes(ssid) > 32 ||
      !((bytes(password) >= 8 && bytes(password) <= 63) || /^[0-9a-fA-F]{64}$/.test(password))
    ) {
      setError(
        'Use a Wi-Fi name of up to 32 bytes and a WPA2 password of 8–63 bytes or a 64-character hexadecimal key.',
      );
      return;
    }
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
      setError('Enter the Device Secret supplied by your platform administrator.');
      return;
    }
    setBusy(true);
    try {
      const approved = await api<{ api_origin: string; root_ca: string; device_code: string }>(
        '/devices/' + encodeURIComponent(String(device.id)) + '/usb-provisioning',
        { cache: 'no-store' },
      );
      if (approved.device_code !== code)
        throw new Error('The selected reader changed. Reopen USB setup.');
      const useLocalProxy =
        import.meta.env.DEV && approved.api_origin === import.meta.env.VITE_DEV_USB_API_ORIGIN;
      const configUrl = useLocalProxy
        ? '/__dev/reader-config'
        : approved.api_origin + '/api/v1/device/config';
      const response = await fetch(configUrl, {
        headers: { 'X-Device-Id': code, Authorization: 'Bearer ' + secret },
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(60000),
      });
      if (response.status >= 500)
        throw new Error(`The reader API is unavailable (HTTP ${response.status}). Try again shortly.`);
      if (!response.ok)
        throw new Error(
          `The API rejected this reader (HTTP ${response.status}). Check its device secret and school registration.`,
        );
      const config: { config_version?: unknown } = await response.json();
      if (!Number.isInteger(config.config_version) || Number(config.config_version) < 1)
        throw new Error(
          'This address did not return a Vidyalayaa device configuration. Check the API address.',
        );
      const result = await usb.provision({
        code,
        ssid,
        password,
        secret,
        origin: approved.api_origin,
        root_ca: approved.root_ca,
      });
      if (result !== 'VIDYALAYAA PROVISION OK RESTART_REQUIRED') {
        const messages: Record<string, string> = {
          'VIDYALAYAA PROVISION ERROR MODE':
            'Boot the ESP32 with GPIO32 connected to GND, then reconnect.',
          'VIDYALAYAA PROVISION ERROR INVALID_CONFIG':
            'The ESP32 rejected these settings. Confirm this board belongs to the selected device code.',
          'VIDYALAYAA PROVISION ERROR STORAGE':
            'The ESP32 could not save the settings. Check the board storage before retrying.',
        };
        throw new Error(
          messages[result] ||
            'The ESP32 did not confirm saving. Reconnect and check it before retrying.',
        );
      }
      setSaved(true);
      setSecret('');
      setPassword('');
      await usb.disconnect();
    } catch (failure) {
      setError(
        failure instanceof TypeError
          ? 'Could not reach the API. Check its address, HTTPS certificate and allowed website origins.'
          : failure instanceof Error
            ? failure.message
            : 'Could not save device settings.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
      dismissible={!busy}
      title={`Set up ${device.name} over USB`}
      description="Save Wi-Fi and the device credential directly to the connected ESP32."
    >
      <div className="space-y-5">
        <p className="text-sm text-muted">
          Connect the ESP32 with a USB data cable and close Serial Monitor. For an already
          configured board, connect GPIO32 to GND and reset before connecting here. You can repeat
          this setup to change Wi-Fi or rotate its secret.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            disabled={busy || usb.status === 'connecting' || !usb.supported}
            onClick={() => void (usb.status === 'connected' ? usb.disconnect() : usb.connect())}
          >
            {usb.status === 'connected'
              ? 'Disconnect ESP32'
              : usb.status === 'connecting'
                ? 'Connecting…'
                : 'Connect ESP32'}
          </Button>
          <span role="status" className="text-sm">
            {usb.status === 'connected' ? 'ESP32 connected' : 'USB disconnected'}
          </span>
        </div>
        {!usb.supported && (
          <p className="field-error">Use desktop Chrome or Edge on HTTPS or localhost.</p>
        )}
        {usb.diagnostics && usb.status === 'connected' && (
          <p className="text-sm text-muted">
            {setupMode
              ? 'USB setup mode detected. NFC components are optional for setup.'
              : 'Gate mode detected. Disconnect, connect GPIO32 to GND, reset and reconnect to edit settings.'}
          </p>
        )}
        {usb.error && (
          <p className="field-error" role="alert">
            {usb.error}
          </p>
        )}
        <form onSubmit={save} autoComplete="off" className="space-y-4">
          <fieldset disabled={busy} className="form-grid">
            <div>
              <label className="field-label" htmlFor="usb-device-code">
                Device code
              </label>
              <input className="input" id="usb-device-code" value={code} readOnly />
            </div>
            <div>
              <label className="field-label" htmlFor="usb-ssid">
                Wi-Fi name (SSID)
              </label>
              <input
                className="input"
                id="usb-ssid"
                value={ssid}
                onChange={(e) => setSsid(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="field-label" htmlFor="usb-password">
                Wi-Fi password
              </label>
              <input
                className="input"
                id="usb-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="field-label" htmlFor="usb-secret">
                Device Secret
              </label>
              <input
                className="input"
                id="usb-secret"
                type="password"
                autoComplete="new-password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                required
              />
            </div>
          </fieldset>
          <p className="text-sm text-muted">
            Enter the current Device Secret each time. Your Super Admin provides the API settings
            automatically. The ESP32 starts using them after a reset.
          </p>
          {error && (
            <p role="alert" className="field-error">
              {error}
            </p>
          )}
          {saved && (
            <p role="status" className="notice">
              Settings saved to the ESP32. Remove the GPIO32 jumper and press EN/RESET. Check Last
              seen on this page after it joins Wi-Fi.
            </p>
          )}
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={close} disabled={busy}>
              Close
            </Button>
            <Button
              type="submit"
              variant="lime"
              disabled={busy || usb.status !== 'connected' || !setupMode}
            >
              {busy ? 'Checking and saving…' : 'Save to ESP32'}
            </Button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}
