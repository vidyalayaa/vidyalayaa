import { useQuery } from '@tanstack/react-query';
import type { FeeAssessment } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { Dialog } from '../../components/ui/dialog';
import { Empty, ErrorState, Loading } from '../../components/common';
import CollectPayment from '../fees/CollectPayment';
// Existing student-profile links share the authoritative collection workflow.
export default function FeePaymentDialog({
  fee,
  close,
}: {
  fee: { id: string } | null;
  close: () => void;
}) {
  const a = useAuth(),
    manage =
      ['school_admin', 'finance_staff'].includes(a.me?.school?.role || '') &&
      !!a.me?.school?.permissions.includes('fees.write');
  const q = useQuery({
    queryKey: [a.school, 'fee-payment-assessment', fee?.id],
    queryFn: () => api<FeeAssessment>(`/fees/assessments/${fee!.id}`),
    enabled: !!fee && manage,
  });
  if (!fee) return null;
  if (!manage)
    return (
      <Dialog
        open
        title="Fee statement"
        onOpenChange={(v) => {
          if (!v) close();
        }}
      >
        <Empty
          title="Read-only statement"
          description="Only School Admin or authorized finance staff can record payments."
        />
      </Dialog>
    );
  if (q.data)
    return (
      <CollectPayment
        fees={[q.data]}
        studentId={q.data.student_id}
        year={q.data.academic_session_id}
        initialId={q.data.id}
        close={close}
      />
    );
  return (
    <Dialog
      open
      title="Record fee payment"
      onOpenChange={(v) => {
        if (!v) close();
      }}
    >
      {q.error ? <ErrorState error={q.error} retry={() => q.refetch()} /> : <Loading />}
    </Dialog>
  );
}
