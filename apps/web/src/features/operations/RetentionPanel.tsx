import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { retentionPolicySchema } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { display } from '../../lib/utils';
import { Panel, Loading, ErrorState } from '../../components/common';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
type Policy = {
  policy_ref: string;
  report_days: number;
  notification_days: number;
  approved_at: string;
};
export default function RetentionPanel() {
  const a = useAuth(),
    qc = useQueryClient(),
    [open, setOpen] = useState(false),
    [error, setError] = useState('');
  const q = useQuery({
    queryKey: [a.school, 'retention'],
    queryFn: () => api<{ policy: Policy | null; plan_report_days: number }>('/school/retention'),
  });
  const save = useMutation({
    mutationFn: (body: unknown) =>
      api('/school/retention', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [a.school, 'retention'] });
      setOpen(false);
    },
    onError: (e) => setError(e.message),
  });
  const disable = useMutation({
    mutationFn: () => api('/school/retention', { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [a.school, 'retention'] }),
  });
  return (
    <Panel
      title="Document and notification retention"
      subtitle="Cleanup applies to generated PDFs and completed notification history. Student, attendance, fee and audit records are retained."
    >
      <div className="settings-body">
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorState error={q.error} />
        ) : (
          <>
            {q.data?.policy ? (
              <>
                <div className="setting-line">
                  <span>Approved policy</span>
                  <strong>{q.data.policy.policy_ref}</strong>
                </div>
                <div className="setting-line">
                  <span>Generated reports</span>
                  <span>
                    {Math.min(q.data.policy.report_days, q.data.plan_report_days)} days (plan cap:{' '}
                    {q.data.plan_report_days})
                  </span>
                </div>
                <div className="setting-line">
                  <span>Completed notification history</span>
                  <span>{q.data.policy.notification_days} days</span>
                </div>
                <p className="my-3 text-xs text-stone-500">
                  Approved {display(q.data.policy.approved_at, a.me?.school?.timezone)}. Cleanup
                  runs in the background.
                </p>
              </>
            ) : (
              <p className="my-4 text-sm">
                Automatic cleanup is inactive. Save an approved policy reference and retention
                periods to enable it.
              </p>
            )}
            <div className="my-4 flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setError('');
                  setOpen(true);
                }}
              >
                {q.data?.policy ? 'Update approved policy' : 'Set approved retention policy'}
              </Button>
              {q.data?.policy && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={disable.isPending}
                  onClick={() => disable.mutate()}
                >
                  Stop future cleanup
                </Button>
              )}
            </div>
            {disable.error && (
              <p className="field-error" role="alert">
                {disable.error.message}
              </p>
            )}
          </>
        )}
      </div>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Approved retention policy"
        description="Use the periods approved for this school. Saving enables cleanup on the next worker cycle; removed files and history cannot be restored from this screen."
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError('');
            const f = new FormData(e.currentTarget);
            const result = retentionPolicySchema.safeParse({
              policy_ref: f.get('policy_ref'),
              report_days: Number(f.get('report_days')),
              notification_days: Number(f.get('notification_days')),
              approved: f.get('approved') === 'on',
            });
            if (!result.success) {
              setError(
                'Enter a policy reference and periods between 7 and 3,650 days, then confirm approval.',
              );
              return;
            }
            save.mutate(result.data);
          }}
        >
          <label className="block field-label">
            Approved policy reference
            <input
              className="input mt-2"
              name="policy_ref"
              required
              minLength={5}
              maxLength={200}
              defaultValue={q.data?.policy?.policy_ref}
            />
          </label>
          <label className="block field-label">
            Generated reports (days)
            <input
              className="input mt-2"
              name="report_days"
              type="number"
              required
              min={7}
              max={3650}
              defaultValue={q.data?.policy?.report_days || q.data?.plan_report_days || 180}
            />
          </label>
          <label className="block field-label">
            Completed notification history (days)
            <input
              className="input mt-2"
              name="notification_days"
              type="number"
              required
              min={7}
              max={3650}
              defaultValue={q.data?.policy?.notification_days || 180}
            />
          </label>
          <label className="flex items-start gap-3 text-sm">
            <input name="approved" type="checkbox" required className="mt-1" />I confirm that these
            periods follow this school’s approved retention policy.
          </label>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="lime" disabled={save.isPending}>
              Save approved policy
            </Button>
          </div>
        </form>
      </Dialog>
    </Panel>
  );
}
