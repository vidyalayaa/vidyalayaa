import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Page } from '@vidyalayaa/contracts';
import { api } from '../../lib/auth';
import { Panel, DataTable, Loading, ErrorState } from '../../components/common';
import { Button } from '../../components/ui/button';
import { ActionDialog } from '../../components/ActionDialog';

export default function FirmwarePanel() {
  const qc = useQueryClient(),
    [page, setPage] = useState(1),
    [devicePage, setDevicePage] = useState(1),
    [choice, setChoice] = useState<{ kind: string; row: Record<string, unknown> } | null>(null);
  const releases = useQuery({
    queryKey: ['platform', 'firmware', page],
    queryFn: () => api<Page>(`/platform/firmware-releases?page=${page}`),
  });
  const devices = useQuery({
    queryKey: ['platform', 'firmware-devices', devicePage],
    queryFn: () => api<Page>(`/platform/devices?page=${devicePage}`),
  });
  const upload = useMutation({
    mutationFn: (body: FormData) => api('/platform/firmware-releases', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform', 'firmware'] }),
  });
  return (
    <div className="space-y-6">
      <Panel title="Signed firmware releases">
        <p className="text-sm mb-5">
          Publish the signed application image with its release manifest. Publishing leaves updates
          disabled. Enable a release only after recording acceptance testing; each reader also needs
          a verified hardware profile and an explicit assignment.
        </p>
        <form
          className="space-y-4 mb-6"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            upload.mutate(new FormData(form), { onSuccess: () => form.reset() });
          }}
        >
          <label className="block field-label">
            Signed application image
            <input
              className="input mt-2"
              type="file"
              name="image"
              accept=".bin,application/octet-stream"
              required
              disabled={upload.isPending}
            />
          </label>
          <label className="block field-label">
            Release manifest JSON
            <textarea
              className="input mt-2 min-h-40 font-mono text-xs"
              name="manifest"
              required
              maxLength={16384}
              disabled={upload.isPending}
            />
          </label>
          {upload.error && (
            <p role="alert" className="field-error">
              {upload.error.message}
            </p>
          )}
          {upload.isSuccess && <p role="status">Release published with updates disabled.</p>}
          <Button variant="lime" disabled={upload.isPending}>
            {upload.isPending ? 'Verifying release…' : 'Publish signed release'}
          </Button>
        </form>
        {releases.isLoading ? (
          <Loading />
        ) : releases.error ? (
          <ErrorState error={releases.error} />
        ) : (
          <DataTable
            rows={releases.data?.data || []}
            columns={[
              'version',
              'channel',
              'hardware_model',
              'security_version',
              'enabled',
              'pipeline_ref',
            ]}
            actions={(row) => (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setChoice({ kind: 'release', row })}
              >
                {row.enabled ? 'Disable release' : 'Enable accepted release'}
              </Button>
            )}
          />
        )}
        <Pager page={page} change={setPage} data={releases.data} />
      </Panel>
      <Panel title="Reader hardware and update assignments">
        <p className="text-sm mb-5">
          Record measured chip revision and flash size from the physical reader. This build profile
          requires ESP32 ECO3 or later with 4 MB flash. Do not infer these values from the product
          name.
        </p>
        {devices.isLoading ? (
          <Loading />
        ) : devices.error ? (
          <ErrorState error={devices.error} />
        ) : (
          <DataTable
            rows={devices.data?.data || []}
            columns={['device_code', 'school_name', 'status', 'firmware_version']}
            actions={(row) => (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setChoice({ kind: 'hardware', row })}
                >
                  Verify hardware
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setChoice({ kind: 'assignment', row })}
                >
                  Assign update
                </Button>
              </div>
            )}
          />
        )}
        <Pager page={devicePage} change={setDevicePage} data={devices.data} />
      </Panel>
      {choice && (
        <ActionDialog
          open
          close={() => setChoice(null)}
          title={
            choice.kind === 'hardware'
              ? 'Record physical hardware verification'
              : choice.kind === 'release'
                ? 'Record release acceptance'
                : 'Assign or withdraw reader update'
          }
          endpoint={
            choice.kind === 'release'
              ? `/platform/firmware-releases/${choice.row.version}`
              : `/platform/devices/${choice.row.id}/${choice.kind === 'hardware' ? 'hardware' : 'ota'}`
          }
          method={choice.kind === 'assignment' ? 'POST' : 'PATCH'}
          fields={
            choice.kind === 'hardware'
              ? [
                  { key: 'hardware_model', type: 'hidden', default: 'ESP32_ECO3_4MB' },
                  { key: 'chip_revision', type: 'number' },
                  { key: 'flash_bytes', type: 'number' },
                  { key: 'verification_ref' },
                ]
              : choice.kind === 'release'
                ? [
                    { key: 'enabled', type: 'boolean', default: String(!choice.row.enabled) },
                    { key: 'reason', type: 'textarea' },
                    { key: 'acceptance_ref' },
                  ]
                : [
                    { key: 'version' },
                    { key: 'enabled', type: 'boolean', default: 'false' },
                    { key: 'reason', type: 'textarea' },
                    { key: 'acceptance_ref' },
                  ]
          }
          onResult={() =>
            qc.invalidateQueries({ predicate: (q) => q.queryKey.includes('platform') })
          }
        />
      )}
    </div>
  );
}
function Pager({ page, change, data }: { page: number; change: (v: number) => void; data?: Page }) {
  return (
    <div className="pagination">
      <span>
        Page {page} · {data?.total ?? 0} records
      </span>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={page === 1} onClick={() => change(page - 1)}>
          Previous
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!data || page * data.page_size >= data.total}
          onClick={() => change(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
