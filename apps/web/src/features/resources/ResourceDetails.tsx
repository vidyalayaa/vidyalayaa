import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Resource } from '@vidyalayaa/contracts';
import { Download } from 'lucide-react';
import { api, useAuth, downloadReport } from '../../lib/auth';
import { display, label } from '../../lib/utils';
import { Dialog } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { ErrorState, Loading } from '../../components/common';
import { fields, resourceInfo } from './metadata';

export default function ResourceDetails({
  resource,
  id,
  close,
}: {
  resource: Resource;
  id: string;
  close: () => void;
}) {
  const a = useAuth(),
    [downloading, setDownloading] = useState(false),
    [error, setError] = useState('');
  const query = useQuery({
    queryKey: [a.school, resource, 'detail', id],
    queryFn: () => api<Record<string, unknown>>(`/resources/${resource}/${id}`),
    staleTime: 0,
  });
  async function download() {
    setDownloading(true);
    setError('');
    try {
      const result = await api<{ url: string }>(`/materials/${id}/download`);
      if (result.url.startsWith('/materials/')) {
        await downloadReport(
          result.url,
          String(query.data?.storage_path || 'learning-material')
            .split('/')
            .at(-1),
        );
        return;
      }
      const url = new URL(result.url),
        origin = new URL(import.meta.env.VITE_SUPABASE_URL).origin;
      if (
        url.origin !== origin ||
        !url.pathname.startsWith('/storage/v1/object/sign/school-documents/')
      )
        throw new Error('The download address is invalid.');
      const response = await fetch(url);
      if (!response.ok) throw new Error('This download is unavailable. Try again.');
      const blob = URL.createObjectURL(await response.blob()),
        link = document.createElement('a');
      link.href = blob;
      link.download =
        String(query.data?.storage_path || 'learning-material')
          .split('/')
          .at(-1) || 'learning-material';
      link.click();
      setTimeout(() => URL.revokeObjectURL(blob), 1000);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setDownloading(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={String(query.data?.title || query.data?.full_name || resourceInfo[resource].title)}
      description="School records shown within your current access permissions."
    >
      {query.isLoading ? (
        <Loading />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => query.refetch()} />
      ) : (
        query.data && (
          <>
            <dl className="grid gap-4">
              {fields[resource]
                .filter((field) => field.key !== 'storage_path')
                .map((field) => {
                  const value = field.key.endsWith('_id')
                    ? query.data![field.key.replace(/_id$/, '_label')]
                    : query.data![field.key];
                  if (value === null || value === undefined || value === '') return null;
                  return (
                    <div key={field.key}>
                      <dt className="field-label">{label(field.key.replace(/_id$/, ''))}</dt>
                      <dd className="whitespace-pre-wrap break-words text-sm leading-6">
                        {typeof value === 'object' ? (
                          <pre className="overflow-auto rounded-lg bg-stone-50 p-3 text-xs">
                            {JSON.stringify(value, null, 2)}
                          </pre>
                        ) : (
                          display(value, a.me?.school?.timezone)
                        )}
                      </dd>
                    </div>
                  );
                })}
            </dl>
            {resource === 'assignments' && !!query.data.storage_path && (
              <Button className="mt-5" variant="lime" disabled={downloading} onClick={download}>
                <Download size={16} />
                {downloading ? 'Downloading…' : 'Download material'}
              </Button>
            )}
            {error && (
              <p className="field-error mt-3" role="alert">
                {error}
              </p>
            )}
          </>
        )
      )}
    </Dialog>
  );
}
