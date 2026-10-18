import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ShieldCheck, Layers3 } from 'lucide-react';
import type { Page } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { toDateTimeLocal } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { PageHeading, Panel, DataTable, Loading, ErrorState, Empty } from '../../components/common';
import { ActionDialog, type ActionField } from '../../components/ActionDialog';
import { Dialog } from '../../components/ui/dialog';
const actions: Record<string, { endpoint: string; fields: ActionField[] }> = {
  school: {
    endpoint: '/platform/schools',
    fields: [
      { key: 'school_code' },
      { key: 'name' },
      { key: 'timezone', default: 'Asia/Kolkata' },
      { key: 'plan_code', options: ['BASIC', 'PROFESSIONAL', 'ENTERPRISE'] },
      { key: 'trial_ends_at', type: 'datetime-local' },
    ],
  },
  device: {
    endpoint: '/platform/devices',
    fields: [
      { key: 'school_id' },
      { key: 'device_code' },
      { key: 'name' },
      { key: 'hardware_serial' },
    ],
  },
  grant: {
    endpoint: '/platform/support-grants',
    fields: [
      { key: 'school_id' },
      { key: 'reason', type: 'textarea' },
      { key: 'ticket_ref' },
      { key: 'scope', type: 'json', default: '["students"]' },
      { key: 'minutes', type: 'number', default: '60' },
    ],
  },
};
export default function Platform() {
  const a = useAuth(),
    qc = useQueryClient(),
    [tab, setTab] = useState('schools'),
    [action, setAction] = useState(''),
    [result, setResult] = useState<Record<string, unknown> | null>(null),
    [selected, setSelected] = useState<Record<string, unknown> | null>(null),
    query = useQuery({
      queryKey: [a.school, 'platform', tab],
      queryFn: () => api<Page>(`/platform/${tab}`),
      enabled: !!a.session,
    });
  return (
    <>
      <PageHeading
        eyebrow="VIDYALAYAA PLATFORM"
        title="Every school. One clear view."
        description="Partner schools, device inventory, plans, and approved support."
        actions={
          <>
            <Button variant="outline" onClick={() => setAction('device')}>
              Register hardware
            </Button>
            <Button variant="lime" onClick={() => setAction('school')}>
              <Plus size={16} />
              Add school
            </Button>
          </>
        }
      />
      <div className="notice">
        <ShieldCheck size={18} />
        Platform access requires MFA. Student records require an approved, time-limited support
        grant.
      </div>
      <div className="tabs">
        {['schools', 'devices', 'plans', 'support-grants'].map((t) => (
          <button key={t} className={tab === t ? 'tab-active' : ''} onClick={() => setTab(t)}>
            {t.replaceAll('-', ' ')}
          </button>
        ))}
      </div>
      <Panel
        title={tab.replaceAll('-', ' ')}
        action={
          tab === 'support-grants' && (
            <Button variant="outline" size="sm" onClick={() => setAction('grant')}>
              Request access
            </Button>
          )
        }
      >
        {query.isLoading ? (
          <Loading />
        ) : query.error ? (
          <ErrorState error={query.error} retry={() => query.refetch()} />
        ) : query.data?.data.length ? (
          <DataTable
            rows={query.data.data}
            onEdit={tab === 'schools' ? setSelected : undefined}
            columns={
              tab === 'schools'
                ? ['school_code', 'name', 'timezone', 'plan', 'subscription_status']
                : tab === 'devices'
                  ? ['device_code', 'name', 'school_name', 'status', 'last_seen_at']
                  : tab === 'plans'
                    ? ['code', 'name', 'features', 'limits']
                    : ['school_id', 'ticket_ref', 'reason', 'expires_at', 'approved_by']
            }
          />
        ) : (
          <Empty />
        )}
      </Panel>
      {actions[action] && (
        <ActionDialog
          open={true}
          close={() => setAction('')}
          title={`Add ${action}`}
          endpoint={actions[action].endpoint}
          fields={actions[action].fields}
          onResult={(r) => {
            if (r.device_secret) setResult(r);
            qc.invalidateQueries({ queryKey: [a.school, 'platform'] });
          }}
        />
      )}
      {selected && (
        <ActionDialog
          open={true}
          close={() => setSelected(null)}
          title={`Subscription for ${selected.name}`}
          endpoint={`/platform/schools/${selected.id}/subscription`}
          method="PATCH"
          fields={[
            {
              key: 'plan_code',
              options: ['BASIC', 'PROFESSIONAL', 'ENTERPRISE'],
              default: String(selected.plan || 'BASIC').toUpperCase(),
            },
            {
              key: 'status',
              options: [
                'TRIALING',
                'ACTIVE',
                'PAST_DUE',
                'SUSPENDED_READONLY',
                'SUSPENDED',
                'CANCELLED',
                'EXPIRED',
              ],
              default: String(selected.subscription_status),
            },
            {
              key: 'current_period_end',
              type: 'datetime-local',
              default: toDateTimeLocal(selected.current_period_end),
            },
            {
              key: 'grace_ends_at',
              type: 'datetime-local',
              optional: true,
              default: toDateTimeLocal(selected.grace_ends_at),
            },
            { key: 'reason', type: 'textarea' },
          ]}
          onResult={() => qc.invalidateQueries({ queryKey: [a.school, 'platform'] })}
        />
      )}
      <Dialog
        open={!!result}
        onOpenChange={(v) => {
          if (!v) setResult(null);
        }}
        title="Provisioning credentials"
        description="Shown once. Copy these credentials into your secure provisioning process."
      >
        <div className="space-y-4">
          {['device_code', 'device_secret', 'claim_code'].map((k) => (
            <div key={k}>
              <p className="field-label">{k.replaceAll('_', ' ')}</p>
              <code className="block break-all rounded-lg bg-stone-100 p-3 text-xs">
                {String(result?.[k] || '')}
              </code>
            </div>
          ))}
          <Button variant="lime" onClick={() => setResult(null)}>
            I have stored these securely
          </Button>
        </div>
      </Dialog>
    </>
  );
}
