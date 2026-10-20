import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  CalendarCheck2,
  CreditCard,
  Wallet,
  Megaphone,
  AlertTriangle,
  ArrowRight,
  ShieldAlert,
  Users,
} from 'lucide-react';
import { api, useAuth, configured } from '../../lib/auth';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/common';
import ClassAttendanceSheet from '../operations/ClassAttendanceSheet';
import { IssueCardDialog } from '../resources/CardActionDialogs';

export default function AdminActionStrip() {
  const a = useAuth(),
    role = a.me?.school?.role;
  const [batchOpen, setBatchOpen] = useState(false);
  const [issueCardOpen, setIssueCardOpen] = useState(false);

  // Corrections query to check for pending approvals
  const correctionsQuery = useQuery({
    queryKey: [a.school, 'pending-corrections'],
    queryFn: () => api<{ total: number; data: Array<{ status: string }> }>('/corrections?page_size=10'),
    enabled: configured && !!a.me?.school?.permissions.includes('attendance.correct_approve'),
    refetchInterval: 60000,
  });

  // Support grants query
  const supportGrantsQuery = useQuery({
    queryKey: [a.school, 'pending-support-grants'],
    queryFn: () => api<{ total: number; data: Array<{ approved_by: string | null; revoked_at: string | null }> }>('/support-grants?page_size=10'),
    enabled: configured && !!a.me?.school?.permissions.includes('users.manage'),
    refetchInterval: 60000,
  });

  const pendingCorrections = correctionsQuery.data?.data?.filter((c) => c.status === 'REQUESTED').length || 0;
  const pendingGrants = supportGrantsQuery.data?.data?.filter((g) => !g.approved_by && !g.revoked_at).length || 0;

  const hasPendingItems = pendingCorrections > 0 || pendingGrants > 0;

  return (
    <div className="mb-8 space-y-4">
      {/* Alert Banner for Pending Reviews */}
      {hasPendingItems && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50/80 p-4 text-xs">
          <div className="flex items-center gap-3">
            <span className="flex size-8 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
              <AlertTriangle size={18} />
            </span>
            <div>
              <p className="font-semibold text-amber-950">Action Required by School Leadership</p>
              <div className="flex flex-wrap gap-2 mt-0.5 text-amber-800">
                {pendingCorrections > 0 && (
                  <span>
                    <strong>{pendingCorrections}</strong> attendance correction{pendingCorrections > 1 ? 's' : ''} awaiting review
                  </span>
                )}
                {pendingCorrections > 0 && pendingGrants > 0 && <span>·</span>}
                {pendingGrants > 0 && (
                  <span>
                    <strong>{pendingGrants}</strong> support access grant request{pendingGrants > 1 ? 's' : ''}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex gap-2">
            {pendingCorrections > 0 && (
              <Button size="sm" variant="outline" asChild className="bg-white text-xs">
                <Link to="/corrections">
                  Review Corrections <ArrowRight size={13} />
                </Link>
              </Button>
            )}
            {pendingGrants > 0 && (
              <Button size="sm" variant="outline" asChild className="bg-white text-xs">
                <Link to="/support-grants">
                  Review Grants <ArrowRight size={13} />
                </Link>
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Leadership Quick Action Bar */}
      <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-xs flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-bold text-stone-900">Leadership Quick Actions</h3>
          <p className="text-xs text-stone-500">Fast workflows for administrators and principals</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {a.me?.school?.permissions.includes('attendance.manual_write') && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setBatchOpen(true)}
              className="text-xs font-medium"
            >
              <CalendarCheck2 size={15} />
              Class Register
            </Button>
          )}

          {a.me?.school?.permissions.includes('cards.manage') && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setIssueCardOpen(true)}
              className="text-xs font-medium"
            >
              <CreditCard size={15} />
              Issue NFC Card
            </Button>
          )}

          {a.me?.school?.permissions.includes('fees.read') && (
            <Button size="sm" variant="outline" asChild className="text-xs font-medium">
              <Link to="/r/fee_records">
                <Wallet size={15} />
                Fee Desk
              </Link>
            </Button>
          )}

          {a.me?.school?.permissions.includes('announcements.write') && (
            <Button size="sm" variant="outline" asChild className="text-xs font-medium">
              <Link to="/r/announcements">
                <Megaphone size={15} />
                Announcement
              </Link>
            </Button>
          )}
        </div>
      </div>

      {batchOpen && (
        <ClassAttendanceSheet
          open={batchOpen}
          close={() => setBatchOpen(false)}
        />
      )}

      {issueCardOpen && (
        <IssueCardDialog
          open={issueCardOpen}
          close={() => setIssueCardOpen(false)}
        />
      )}
    </div>
  );
}
