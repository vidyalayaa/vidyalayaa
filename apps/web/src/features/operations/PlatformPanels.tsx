import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Page } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { display, label, toDateTimeLocal, fromDateTimeLocal } from '../../lib/utils';
import { Dialog } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Panel, Loading, ErrorState, DataTable, Empty, Badge } from '../../components/common';

export function SupportTicketResponse({
  ticket,
  close,
}: {
  ticket: Record<string, unknown>;
  close: () => void;
}) {
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/platform/support-requests/${ticket.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ predicate: (query) => query.queryKey.includes('platform') });
      close();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !save.isPending) close();
      }}
      title={`Respond: ${ticket.subject}`}
      description={String(ticket.school_name || 'School support request')}
    >
      <div className="mb-5 rounded-xl border p-4">
        <p className="field-label">School request</p>
        <p className="whitespace-pre-wrap break-words text-sm">
          {String(ticket.description || '')}
        </p>
      </div>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          save.mutate({ status: fields.get('status'), response: fields.get('response') });
        }}
      >
        <div>
          <label className="field-label" htmlFor="ticket-status">
            Status
          </label>
          <select
            id="ticket-status"
            className="input"
            name="status"
            defaultValue={String(ticket.status)}
          >
            {['OPEN', 'IN_PROGRESS', 'RESOLVED'].map((status) => (
              <option key={status} value={status}>
                {label(status)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="ticket-response">
            Response
          </label>
          <textarea
            id="ticket-response"
            className="input min-h-32"
            name="response"
            required
            minLength={5}
            maxLength={2000}
            defaultValue={String(ticket.response || '')}
          />
        </div>
        {save.error && (
          <p role="alert" className="field-error">
            {save.error.message}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={save.isPending} onClick={close}>
            Cancel
          </Button>
          <Button variant="lime" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save response'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function PlanEditor({ plan, close }: { plan: Record<string, unknown>; close: () => void }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/platform/plans/${plan.id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ predicate: (q) => q.queryKey.includes('platform') });
      close();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) close();
      }}
      title={`Edit ${plan.name} plan`}
      description="Changes apply to every school on this plan. School-specific overrides remain in place."
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          save.mutate({
            name: f.get('name'),
            is_active: f.get('is_active') === 'on',
            features: Object.fromEntries(
              Object.keys(plan.features as object).map((k) => [k, f.get('feature.' + k) === 'on']),
            ),
            limits: Object.fromEntries(
              Object.keys(plan.limits as object).map((k) => [k, Number(f.get('limit.' + k))]),
            ),
            reason: f.get('reason'),
          });
        }}
      >
        <label className="block field-label">
          Plan name
          <input
            className="input mt-2"
            name="name"
            defaultValue={String(plan.name)}
            required
            minLength={2}
          />
        </label>
        <label className="flex gap-2 text-sm">
          <input type="checkbox" name="is_active" defaultChecked={Boolean(plan.is_active)} />
          Available for new subscriptions
        </label>
        <fieldset className="space-y-3">
          <legend className="field-label">Included features</legend>
          {Object.entries(plan.features as Record<string, boolean>).map(([k, v]) => (
            <label key={k} className="flex gap-3 text-sm">
              <input type="checkbox" name={'feature.' + k} defaultChecked={v} />
              {label(k)}
            </label>
          ))}
        </fieldset>
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="field-label">Plan limits</legend>
          {Object.entries(plan.limits as Record<string, number>).map(([k, v]) => (
            <label key={k} className="block text-sm">
              {label(k)}
              <input
                className="input mt-1"
                type="number"
                min={0}
                max={100000000}
                step={1}
                required
                name={'limit.' + k}
                defaultValue={v}
              />
            </label>
          ))}
        </fieldset>
        <label className="block field-label">
          Reason for change
          <textarea name="reason" className="input mt-2" required minLength={5} maxLength={1000} />
        </label>
        {save.error && (
          <p role="alert" className="field-error">
            {save.error.message}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button variant="lime" disabled={save.isPending}>
            Save plan
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
export function SubscriptionEditor({
  school,
  close,
}: {
  school: Record<string, unknown>;
  close: () => void;
}) {
  const qc = useQueryClient(),
    [planId, setPlanId] = useState(String(school.plan_id || '')),
    [status, setStatus] = useState(String(school.subscription_status || 'TRIALING')),
    [error, setError] = useState('');
  const plans = useQuery({
    queryKey: ['platform', 'plans', 'editor'],
    queryFn: () => api<{ data: Record<string, unknown>[] }>('/platform/plans'),
  });
  const plan =
      plans.data?.data.find((p) => String(p.id) === planId) ||
      plans.data?.data.find(
        (p) => p.code === String(school.plan_code || school.plan).toUpperCase(),
      ),
    overrides = (school.limit_overrides || {}) as Record<string, number>,
    zone = String(school.timezone || 'Asia/Kolkata');
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/platform/schools/${school.id}/subscription`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ predicate: (q) => q.queryKey.includes('platform') });
      close();
    },
    onError: (e) => setError(e.message),
  });
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) close();
      }}
      title={`Subscription for ${school.name}`}
      description={`Dates use the school timezone (${zone}). Blank override fields use the selected plan's limits.`}
    >
      {plans.isLoading ? (
        <Loading />
      ) : plans.error ? (
        <ErrorState error={plans.error} />
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError('');
            const f = new FormData(e.currentTarget);
            try {
              const limits = Object.fromEntries(
                Object.keys((plan?.limits || {}) as object)
                  .filter((k) => String(f.get('limit.' + k) || '').trim() !== '')
                  .map((k) => [k, Number(f.get('limit.' + k))]),
              );
              save.mutate({
                plan_id: plan?.id,
                status: f.get('status'),
                current_period_end: fromDateTimeLocal(String(f.get('current_period_end')), zone),
                grace_ends_at: f.get('grace_ends_at')
                  ? fromDateTimeLocal(String(f.get('grace_ends_at')), zone)
                  : null,
                limit_overrides: limits,
                reason: f.get('reason'),
                billing_ref: String(f.get('billing_ref') || '').trim() || null,
                export_until: f.get('export_until')
                  ? fromDateTimeLocal(String(f.get('export_until')), zone)
                  : null,
              });
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          {!school.subscription_status && (
            <p className="text-sm text-muted-foreground" role="status">
              This school has no subscription yet. Choose a plan and dates to set it up.
            </p>
          )}
          <label className="block field-label">
            Plan
            <select
              className="input mt-2"
              required
              value={String(plan?.id || '')}
              onChange={(e) => setPlanId(e.target.value)}
            >
              <option value="" disabled>
                Choose a plan
              </option>
              {plans.data?.data
                .filter((p) => p.is_active || p.id === school.plan_id)
                .map((p) => (
                  <option key={String(p.id)} value={String(p.id)}>
                    {String(p.name)}
                  </option>
                ))}
            </select>
          </label>
          <label className="block field-label">
            Status
            <select
              className="input mt-2"
              name="status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {[
                'TRIALING',
                'ACTIVE',
                'PAST_DUE',
                'SUSPENDED_READONLY',
                'SUSPENDED',
                'CANCELLED',
                'EXPIRED',
              ].map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </select>
          </label>
          <label className="block field-label">
            Current period ends
            <input
              className="input mt-2"
              type="datetime-local"
              name="current_period_end"
              required
              defaultValue={toDateTimeLocal(school.current_period_end, zone)}
            />
          </label>
          <label className="block field-label">
            Grace period ends (optional)
            <input
              className="input mt-2"
              type="datetime-local"
              name="grace_ends_at"
              defaultValue={toDateTimeLocal(school.grace_ends_at, zone)}
            />
          </label>
          <label className="block field-label">
            Contractual export deadline
            <input
              className="input mt-2"
              type="datetime-local"
              name="export_until"
              required={['SUSPENDED', 'CANCELLED', 'EXPIRED'].includes(status)}
              defaultValue={toDateTimeLocal(school.export_until, zone)}
            />
            <span className="mt-2 text-xs font-normal">
              Required when ending access. Use the school’s approved contract; a blank date never
              grants unlimited exports.
            </span>
          </label>
          <fieldset className="grid gap-3 sm:grid-cols-2" key={String(plan?.id)}>
            <legend className="field-label">School-specific limits</legend>
            {Object.entries((plan?.limits || {}) as Record<string, number>).map(([k, v]) => (
              <label className="block text-sm" key={k}>
                {label(k)}
                <input
                  className="input mt-1"
                  type="number"
                  min={0}
                  max={100000000}
                  step={1}
                  name={'limit.' + k}
                  defaultValue={overrides[k] ?? ''}
                  placeholder={`Plan default: ${v}`}
                />
              </label>
            ))}
          </fieldset>
          <p className="text-sm text-muted-foreground">
            Billing is manual. Confirm payment or the approved contract before changing access.
          </p>
          <label className="block field-label">
            Payment or contract reference (optional)
            <input
              className="input mt-2"
              name="billing_ref"
              defaultValue={String(school.billing_ref || '')}
              minLength={3}
              maxLength={200}
            />
          </label>
          <label className="block field-label">
            Reason for change
            <textarea className="input mt-2" name="reason" required minLength={5} />
          </label>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button variant="lime" disabled={save.isPending}>
              Save subscription
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
type WorkerHeartbeat = {
  id: string;
  worker_name?: string | null;
  state: 'STARTING' | 'RUNNING' | 'DEGRADED' | 'STOPPING';
  alive: boolean;
  ready: boolean | null;
  last_seen_at: string;
  last_success_at: string | null;
  last_error_code: string | null;
};

function workerStatus(worker: WorkerHeartbeat) {
  if (worker.state !== 'RUNNING') return worker.state;
  return worker.ready ? 'RUNNING' : 'NOT_READY';
}

const workerColumns = ['worker_id', 'status', 'last_seen_at', 'last_success_at', 'last_error_code'];

function BackgroundWorkers({ workers }: { workers: WorkerHeartbeat[] }) {
  const active = workers
    .filter((worker) => worker.alive && worker.state !== 'STOPPING')
    .map((worker) => ({
      ...worker,
      worker_id: worker.id,
      worker_label: worker.worker_name || 'Unnamed worker',
      status: workerStatus(worker),
    }));
  const running = active.filter(({ status }) => status === 'RUNNING').length;

  return (
    <section className="mt-6 space-y-4" aria-labelledby="background-workers">
      <div>
        <h3 id="background-workers" className="font-semibold">
          Background workers
        </h3>
        <p className="mt-1 text-sm text-stone-600">
          {running} running · {active.length - running} checking in but not ready
        </p>
      </div>
      {active.length ? (
        <section aria-label="Active workers">
          <h4 className="mb-2 text-sm font-semibold">Active workers ({active.length})</h4>
          <DataTable rows={active} columns={workerColumns} />
        </section>
      ) : (
        <p className="notice">
          No background workers are currently checking in. Start the background worker to process
          notifications and reports.
        </p>
      )}
    </section>
  );
}

export function PlatformHealth() {
  const q = useQuery({
    queryKey: ['platform', 'operations'],
    queryFn: () =>
      api<{
        metrics: Record<string, number>;
        workers: WorkerHeartbeat[];
        server_time: string;
      }>('/platform/operations'),
    refetchInterval: 30000,
  });
  return (
    <Panel
      title="Platform health"
      subtitle="Aggregated usage and processing health. Refreshed every 30 seconds."
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : (
        q.data && (
          <div className="p-5">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {Object.entries(q.data.metrics).map(([k, v]) => (
                <div className="rounded-xl border border-stone-200 p-4" key={k}>
                  <p className="text-xs text-stone-600">{label(k)}</p>
                  <strong className="mt-2 block text-2xl">{Number(v).toLocaleString()}</strong>
                </div>
              ))}
            </div>
            <BackgroundWorkers workers={q.data.workers} />
            <p className="mt-4 text-xs text-stone-500">Observed {display(q.data.server_time)}</p>
          </div>
        )
      )}
    </Panel>
  );
}
export function SupportData({
  grant,
  close,
}: {
  grant: Record<string, unknown>;
  close: () => void;
}) {
  const qc = useQueryClient(),
    a = useAuth(),
    scope = grant.scope as string[],
    [feature, setFeature] = useState(scope[0]),
    [page, setPage] = useState(1),
    [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(t);
      qc.removeQueries({ queryKey: ['support-data', grant.id] });
    };
  }, [grant.id, qc]);
  const expired = now >= new Date(String(grant.expires_at)).getTime(),
    q = useQuery({
      queryKey: ['support-data', grant.id, feature, page],
      queryFn: () => api<Page>(`/platform/support-grants/${grant.id}/${feature}?page=${page}`),
      enabled: !expired && !!a.session,
      staleTime: 0,
      gcTime: 0,
      retry: false,
      refetchInterval: 15000,
    });
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) close();
      }}
      title={`Support ticket ${grant.ticket_ref}`}
      description={`Read-only access. Every returned record is audited. Expires ${display(grant.expires_at)}.`}
    >
      {expired ? (
        <p role="alert" className="notice">
          This support grant has expired. School approval is required for further access.
        </p>
      ) : (
        <>
          <div className="tabs">
            {scope.map((s) => (
              <button
                key={s}
                className={s === feature ? 'tab-active' : ''}
                onClick={() => {
                  setFeature(s);
                  setPage(1);
                }}
              >
                {label(s)}
              </button>
            ))}
          </div>
          {q.isLoading ? (
            <Loading />
          ) : q.error ? (
            <ErrorState error={q.error} />
          ) : q.data?.data.length ? (
            <div className="max-h-80 overflow-auto">
              {q.data.data.map((row) => (
                <dl key={String(row.id)} className="mb-4 space-y-2 rounded-xl border p-4">
                  {Object.entries(row)
                    .filter(([k]) => !k.endsWith('_id') && k !== 'id')
                    .map(([k, v]) => (
                      <div key={k}>
                        <dt className="text-xs text-stone-500">{label(k)}</dt>
                        <dd className="break-words text-sm">{display(v)}</dd>
                      </div>
                    ))}
                </dl>
              ))}
            </div>
          ) : (
            <Empty />
          )}
          <div className="pagination">
            <span>
              Page {page} · {q.data?.total || 0} records
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={page === 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!q.data || page * q.data.page_size >= q.data.total}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </Dialog>
  );
}
