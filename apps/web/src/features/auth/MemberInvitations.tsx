import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { InvitationResult, SchoolInvitation } from '@vidyalayaa/contracts';
import { api, configured, useAuth } from '../../lib/auth';
import { DataTable, Empty, ErrorState, Loading, Panel } from '../../components/common';
import { Button } from '../../components/ui/button';
import { useRows } from '../../lib/use-records';
import Pagination from '../../components/Pagination';

export default function MemberInvitations() {
  const a = useAuth(),
    qc = useQueryClient();
  const [message, setMessage] = useState('');
  const query = useRows('/invitations');
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
          rows={query.data.data as unknown as Record<string, unknown>[]}
          columns={['full_name', 'email', 'role_code', 'status', 'expires_at']}
          actions={(row) =>
            !['ACCEPTED', 'REVOKED'].includes(String(row.status)) ? (
              <>
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
          title="No invitations yet"
          description="Invite a colleague using the button above."
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
