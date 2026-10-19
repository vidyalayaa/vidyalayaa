import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { SchoolInvitation } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { label } from '../../lib/utils';
import { Panel, ErrorState } from '../../components/common';
import { Button } from '../../components/ui/button';

export default function PendingInvitations() {
  const auth = useAuth(),
    qc = useQueryClient(),
    navigate = useNavigate();
  const query = useQuery({
    queryKey: ['pending-invitations', auth.session?.user.id],
    queryFn: () => api<{ data: SchoolInvitation[] }>('/invitations/pending'),
    enabled: !!auth.session,
    retry: false,
  });
  const respond = useMutation({
    mutationFn: ({ id, accept }: { id: string; accept: boolean }) =>
      api<{ school_id: string; accepted: boolean }>(`/invitations/${id}/respond`, {
        method: 'POST',
        body: JSON.stringify({ accept }),
      }),
    onSuccess: (result) => {
      if (result.accepted) {
        auth.setSchool(result.school_id);
        navigate('/', { replace: true });
      } else {
        qc.invalidateQueries({ queryKey: ['pending-invitations'] });
        qc.invalidateQueries({ queryKey: ['me'] });
      }
    },
  });
  if (query.error) return <ErrorState error={query.error} retry={() => query.refetch()} />;
  if (!query.data?.data.length) return null;
  return (
    <Panel
      title="Your school invitations"
      subtitle="Review the school and role before accepting access."
    >
      <div className="p-5 space-y-4">
        {query.data.data.map((invitation) => (
          <div
            key={invitation.id}
            className="flex flex-wrap items-center justify-between gap-4 rounded-xl border p-4"
          >
            <div>
              <h3 className="font-semibold">{invitation.school_name}</h3>
              <p className="text-sm text-stone-600">{label(invitation.role_code)} invitation</p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={respond.isPending}
                onClick={() => respond.mutate({ id: invitation.id, accept: false })}
              >
                Decline
              </Button>
              <Button
                variant="lime"
                disabled={respond.isPending}
                onClick={() => respond.mutate({ id: invitation.id, accept: true })}
              >
                Accept invitation
              </Button>
            </div>
          </div>
        ))}
        {respond.error && (
          <p className="field-error" role="alert">
            {respond.error.message}
          </p>
        )}
      </div>
    </Panel>
  );
}
