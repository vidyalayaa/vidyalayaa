import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Page } from '@vidyalayaa/contracts';
import { deviceTuningSchema } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { label } from '../../lib/utils';
import { Dialog } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { DataTable, ErrorState } from '../../components/common';
import Pagination from '../../components/Pagination';
const numeric = {
  heartbeat_interval_s: { value: 60, min: 30, max: 300 },
  batch_max_events: { value: 50, min: 1, max: 50 },
  batch_max_bytes: { value: 100000, min: 1000, max: 256000 },
  tap_debounce_ms: { value: 1500, min: 500, max: 10000 },
  time_sync_interval_h: { value: 6, min: 1, max: 24 },
  storage_warn_pct: { value: 80, min: 50, max: 95 },
};
export default function DeviceConfiguration({
  device,
  close,
}: {
  device: Record<string, unknown>;
  close: () => void;
}) {
  const a = useAuth(),
    qc = useQueryClient(),
    [error, setError] = useState(''),
    [page, setPage] = useState(1),
    config = (device.config || {}) as Record<string, unknown>,
    feedback = (config.feedback || {}) as Record<string, unknown>;
  const history = useQuery({
    queryKey: [a.school, 'device-config', device.id, page],
    queryFn: () => api<Page>(`/devices/${device.id}/configurations?page=${page}`),
  });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/devices/${device.id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [a.school] });
      close();
    },
    onError: (e) => setError(e.message),
  });
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) close();
      }}
      title={`Reader settings · ${device.name}`}
      description="Readers receive the next version when they connect. Every saved configuration is retained in history."
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          const f = new FormData(e.currentTarget);
          try {
            const tuning = deviceTuningSchema.parse({
              ...Object.fromEntries(Object.keys(numeric).map((k) => [k, Number(f.get(k))])),
              feedback: {
                led_brightness: Number(f.get('led_brightness')),
                buzzer: f.get('buzzer') === 'on',
                show_result_on_oled: f.get('show_result_on_oled') === 'on',
              },
            });
            save.mutate({
              name: device.name,
              location_id: device.location_id,
              status: device.status,
              reason: f.get('reason'),
              config: tuning,
            });
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {Object.entries(numeric).map(([k, v]) => (
            <label className="block text-sm" key={k}>
              {label(k)}
              <input
                name={k}
                type="number"
                className="input mt-2"
                defaultValue={Number(config[k] ?? v.value)}
                required
                min={v.min}
                max={v.max}
                step={1}
              />
            </label>
          ))}
        </div>
        <label className="block text-sm">
          LED brightness (%)
          <input
            className="input mt-2"
            name="led_brightness"
            type="number"
            min={0}
            max={100}
            defaultValue={Number(feedback.led_brightness ?? 60)}
            required
          />
        </label>
        <label className="flex gap-3 text-sm">
          <input name="buzzer" type="checkbox" defaultChecked={feedback.buzzer !== false} />
          Sound feedback
        </label>
        <label className="flex gap-3 text-sm">
          <input
            name="show_result_on_oled"
            type="checkbox"
            defaultChecked={feedback.show_result_on_oled === true}
          />
          Display attendance result on OLED
        </label>
        <label className="block text-sm">
          Reason for change
          <textarea name="reason" className="input mt-2" required minLength={5} maxLength={1000} />
        </label>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button variant="lime" disabled={save.isPending || device.status === 'REVOKED'}>
            Save reader settings
          </Button>
        </div>
      </form>
      <h3 className="mb-3 mt-6 font-semibold">Configuration history</h3>
      {history.error ? (
        <ErrorState error={history.error} />
      ) : history.data?.data.length ? (
        <DataTable
          rows={history.data.data}
          columns={['version', 'editor', 'created_at', 'config']}
        />
      ) : (
        <p className="text-sm text-stone-500">No configuration changes have been recorded yet.</p>
      )}
      <Pagination
        total={history.data?.total}
        page={page}
        pageSize={history.data?.page_size}
        onPage={setPage}
      />
    </Dialog>
  );
}
