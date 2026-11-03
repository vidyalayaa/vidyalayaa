import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { invitationDisplayStatuses, type InvitationResult } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { DataTable, Empty, ErrorState, Loading, Panel } from '../../components/common';
import { Button } from '../../components/ui/button';
import { useRows } from '../../lib/use-records';
import Pagination from '../../components/Pagination';

export default function MemberInvitations({ filters }: { filters: string }) {
  const a = useAuth(),
    qc = useQueryClient();
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState('');
  const query = useRows(`/invitations?${filters}${status ? `&status=${status}` : ''}`);
  const change = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'resend' | 'cancel' }) =>
      api<InvitationResult | undefined>(`/invitations/${id}/${action}`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: (value) => {
      setMessage(
        !value
          ? 'Invitation cancelled.'
          : value.status === 'READY'
            ? 'This invitation is ready in the existing account. Ask the person to sign in and accept it.'
            : value.email_sent === false
              ? 'This invitation is already pending. No additional email was sent.'
              : 'The setup email has been sent.',
      );
      qc.invalidateQueries({ queryKey: [a.school] });
    },
  });
  return (
    <Panel
      title="Invitations"
      subtitle="An invitation becomes school access only after the recipient accepts it."
    >
      <div className="px-5 pb-4">
        <label className="field-label" htmlFor="member-invitation-status">
          Invitation status
        </label>
        <select
          id="member-invitation-status"
          className="input max-w-xs"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">All invitation statuses</option>
          {invitationDisplayStatuses.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </div>
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {change.error && (
        <p className="field-error p-4" role="alert">
          {change.error.message}
        </p>
      )}
      {query.isLoading ? (
        <Loading />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => query.refetch()} />
      ) : query.data?.data.length ? (
        <DataTable
          rows={query.data.data.map((row) => ({
            ...row,
            status: row.display_status,
            delivery_failed: row.status === 'FAILED',
          }))}
          columns={['full_name', 'email', 'role_code', 'status', 'expires_at']}
          actions={(row) =>
            !['Accepted', 'Cancelled'].includes(String(row.status)) ? (
              <>
                {row.delivery_failed === true && (
                  <span className="text-xs text-stone-600">Delivery failed</span>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={change.isPending}
                  onClick={() => change.mutate({ id: String(row.id), action: 'resend' })}
                >
                  Resend
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={change.isPending}
                  onClick={() => change.mutate({ id: String(row.id), action: 'cancel' })}
                >
                  Cancel invitation
                </Button>
              </>
            ) : null
          }
        />
      ) : (
        <Empty
          title="No matching invitations"
          description="Change the filters or invite someone in this category."
        />
      )}
      <Pagination
        total={query.data?.total}
        page={query.page}
        pageSize={query.data?.page_size}
        onPage={query.setPage}
      />
    </Panel>
  );
}
