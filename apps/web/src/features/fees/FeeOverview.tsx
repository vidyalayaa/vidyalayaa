import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { FeeSummary } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { schoolPath } from '../../lib/portals';
import { FeeTotals } from './Fees';
export default function FeeOverview() {
  const a = useAuth(),
    q = useQuery({
      queryKey: [a.school, 'fee-overview'],
      queryFn: () => api<{ summary: FeeSummary[] }>('/fees/reports'),
      enabled:
        !!a.me?.school?.permissions.includes('fees.read') &&
        ['school_admin', 'principal'].includes(a.me?.school?.role || ''),
    });
  return (
    <section className="mb-6 space-y-3" aria-label="Fee collection overview">
      <div className="flex justify-between gap-3">
        <h2 className="text-lg font-semibold">Fee collection</h2>
        <Link className="text-sm underline" to={schoolPath('/r/fee_records', a.me?.school?.role)}>
          Manage fees & reports
        </Link>
      </div>
      {q.data?.summary.length ? (
        <FeeTotals rows={q.data.summary} />
      ) : (
        <p className="text-sm text-stone-500">
          {q.isLoading
            ? 'Loading fee totals…'
            : q.error
              ? 'Fee totals are temporarily unavailable. Open Fees to retry.'
              : 'No fees assessed yet.'}
        </p>
      )}
    </section>
  );
}
