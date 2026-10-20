import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Page } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { Panel, DataTable, Loading, ErrorState, Empty } from '../../components/common';
import { Button } from '../../components/ui/button';
import { ActionDialog } from '../../components/ActionDialog';
export default function SupportRequests() {
  const a = useAuth(),
    [open, setOpen] = useState(false),
    [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: [a.school, 'support-requests', page],
    queryFn: () => api<Page>(`/support-requests?page=${page}`),
  });
  return (
    <>
      <Panel
        title="Contact platform support"
        subtitle="Use school and device references. Keep student records, passwords and credentials out of requests."
        action={
          <Button variant="lime" onClick={() => setOpen(true)}>
            New support request
          </Button>
        }
      >
        {query.isLoading ? (
          <Loading />
        ) : query.error ? (
          <ErrorState error={query.error} retry={() => query.refetch()} />
        ) : query.data?.data.length ? (
          <DataTable
            rows={query.data.data}
            columns={['subject', 'category', 'description', 'status', 'response', 'updated_at']}
          />
        ) : (
          <Empty
            title="No support requests"
            description="Open a request when your school needs help."
          />
        )}
        <div className="pagination">
          <Button variant="outline" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span>Page {page}</span>
          <Button
            variant="outline"
            disabled={!query.data || page * query.data.page_size >= query.data.total}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </Panel>
      <ActionDialog
        open={open}
        close={() => setOpen(false)}
        title="New support request"
        endpoint="/support-requests"
        fields={[
          { key: 'subject' },
          { key: 'category', options: ['ACCOUNT', 'BILLING', 'DEVICE', 'OTHER'] },
          { key: 'description', type: 'textarea' },
        ]}
      />
    </>
  );
}
