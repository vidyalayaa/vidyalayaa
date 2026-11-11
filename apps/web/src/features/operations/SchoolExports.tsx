import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, downloadReport, useAuth } from '../../lib/auth';
import { useRows } from '../../lib/use-records';
import { PageHeading, Panel, DataTable, Loading, ErrorState, Empty } from '../../components/common';
import { Button } from '../../components/ui/button';
import { ActionDialog } from '../../components/ActionDialog';
import { Dialog } from '../../components/ui/dialog';
import Pagination from '../../components/Pagination';
interface ExportFile {
  index: number;
  name: string;
  sha256: string;
  bytes: number;
  url: string;
}
export function OffboardingApproval() {
  const q = useRows('/offboarding'),
    [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  if (!q.data?.data.length) return null;
  return (
    <Panel
      title="School closure requests"
      subtitle="School approval does not delete records. Closing requires a separate platform decision and synchronized readers."
    >
      <DataTable
        rows={q.data.data}
        columns={['policy_ref', 'status', 'export_until', 'delete_after', 'legal_hold']}
        actions={(r) =>
          !r.permanent && ['REQUESTED', 'APPROVED'].includes(String(r.status)) ? (
            <Button variant="outline" size="sm" onClick={() => setSelected(r)}>
              Review decision
            </Button>
          ) : null
        }
      />
      {selected && (
        <ActionDialog
          open
          close={() => setSelected(null)}
          title="School closure decision"
          endpoint={`/offboarding/${selected.id}/approve`}
          fields={[
            { key: 'approve', type: 'boolean', default: 'false' },
            { key: 'policy_ref', default: String(selected.policy_ref) },
          ]}
        />
      )}
    </Panel>
  );
}
export default function SchoolExports() {
  const a = useAuth(),
    q = useRows('/exports'),
    [create, setCreate] = useState(false),
    [id, setId] = useState(''),
    [error, setError] = useState('');
  const files = useQuery({
    queryKey: [a.school, 'export-files', id],
    queryFn: () => api<{ files: ExportFile[] }>(`/exports/${id}`),
    enabled: !!id,
    staleTime: 0,
  });
  return (
    <>
      <PageHeading
        title="Your school records, together."
        description="Download school data as JSON or CSV with private materials and file integrity checks. Exports are available only to current School Admins."
        actions={
          <Button variant="lime" onClick={() => setCreate(true)}>
            Create school export
          </Button>
        }
      />
      <OffboardingApproval />
      <Panel
        title="School exports"
        subtitle="The worker reads a consistent database snapshot. Every listed file must download successfully for a complete backup."
      >
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorState error={q.error} retry={() => q.refetch()} />
        ) : q.data?.data.length ? (
          <DataTable
            rows={q.data.data}
            columns={['created_at', 'format', 'status', 'snapshot_at', 'error_code']}
            actions={(r) => (
              <Button
                variant="outline"
                size="sm"
                disabled={r.status !== 'COMPLETED'}
                onClick={() => setId(String(r.id))}
              >
                Open files
              </Button>
            )}
          />
        ) : (
          <Empty title="No school exports yet" />
        )}
        <Pagination
          page={q.page}
          onPage={q.setPage}
          total={q.data?.total}
          pageSize={q.data?.page_size}
        />
      </Panel>
      <ActionDialog
        open={create}
        close={() => setCreate(false)}
        title="Create a private school export"
        endpoint="/exports"
        fields={[
          { key: 'format', options: ['JSON', 'CSV'], default: 'JSON' },
          { key: 'reason', type: 'textarea' },
        ]}
      />
      <Dialog
        open={!!id}
        onOpenChange={(v) => {
          if (!v) setId('');
        }}
        title="Export files"
        description="Download all parts, school/user metadata, and included document files. Access is checked again for each download."
      >
        {files.isLoading ? (
          <Loading />
        ) : files.error ? (
          <ErrorState error={files.error} retry={() => files.refetch()} />
        ) : (
          <div className="space-y-3">
            {files.data?.files.map((f) => (
              <div key={f.index} className="rounded-xl border p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="break-all text-sm">{f.name}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      try {
                        const fresh = await api<{ files: ExportFile[] }>(`/exports/${id}`);
                        const current = fresh.files.find((x) => x.index === f.index);
                        if (!current) throw new Error('This export has changed.');
                        await downloadReport(current.url, current.name);
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    Download
                  </Button>
                </div>
                <details className="mt-2 text-xs">
                  <summary>File integrity</summary>
                  <p className="break-all">SHA-256: {f.sha256}</p>
                  <p>{f.bytes} bytes</p>
                </details>
              </div>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
      </Dialog>
    </>
  );
}
