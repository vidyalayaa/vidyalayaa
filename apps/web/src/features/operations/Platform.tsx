import { useEffect, useState } from 'react';
import FirmwarePanel from './FirmwarePanel';
import { platformSections } from '../../lib/portals';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ShieldCheck, Layers3 } from 'lucide-react';
import type { Page, AdminOnboarding } from '@vidyalayaa/contracts';
import FirstAdministratorDialog from './FirstAdministratorDialog';
import { PlanEditor, PlatformHealth, SupportData, SubscriptionEditor } from './PlatformPanels';
import { api, useAuth } from '../../lib/auth';
import { toDateTimeLocal } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { PageHeading, Panel, DataTable, Loading, ErrorState, Empty } from '../../components/common';
import { ActionDialog, type ActionField } from '../../components/ActionDialog';
import { Dialog } from '../../components/ui/dialog';
const actions: Record<string, { endpoint: string; fields: ActionField[] }> = {
  organization: { endpoint: '/platform/organizations', fields: [{ key: 'name' }] },
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
      { key: 'school_id', lookup: '/platform/schools' },
      { key: 'device_code' },
      { key: 'name' },
      { key: 'hardware_serial' },
    ],
  },
  grant: {
    endpoint: '/platform/support-grants',
    fields: [
      { key: 'school_id', lookup: '/platform/schools' },
      { key: 'reason', type: 'textarea' },
      { key: 'ticket_ref' },
      {
        key: 'scope',
        type: 'multiselect',
        options: ['students', 'attendance', 'marks', 'fees'],
        default: '["students"]',
      },
      { key: 'minutes', type: 'number', default: '60' },
    ],
  },
};
export default function Platform() {
  const navigate = useNavigate(),
    location = useLocation();
  const a = useAuth(),
    qc = useQueryClient(),
    [tab, setTab] = useState('schools'),
    [auditChange, setAuditChange] = useState<Record<string, unknown> | null>(null),
    [page, setPage] = useState(1),
    [search, setSearch] = useState(''),
    [plan, setPlan] = useState<Record<string, unknown> | null>(null),
    [support, setSupport] = useState<Record<string, unknown> | null>(null),
    [action, setAction] = useState(''),
    [device, setDevice] = useState<Record<string, unknown> | null>(null),
    [campus, setCampus] = useState<Record<string, unknown> | null>(null),
    [closure, setClosure] = useState<Record<string, unknown> | null>(null),
    [closureAction, setClosureAction] = useState(''),
    [ticket, setTicket] = useState<Record<string, unknown> | null>(null),
    [result, setResult] = useState<Record<string, unknown> | null>(null),
    [selected, setSelected] = useState<Record<string, unknown> | null>(null),
    [onboarding, setOnboarding] = useState<Record<string, unknown> | null>(null),
    query = useQuery({
      queryKey: [a.school, 'platform', tab, page, search],
      queryFn: () =>
        api<Page>(`/platform/${tab}?page=${page}&search=${encodeURIComponent(search)}`),
      enabled: !!a.session && !['health', 'firmware'].includes(tab),
    });
  useEffect(() => {
    const current = location.pathname.split('/')[2] || 'schools';
    if (platformSections.some((section) => section === current)) {
      setTab(current);
      setPage(1);
      setSearch('');
    }
  }, [location.pathname]);
  return (
    <>
      {ticket && (
        <ActionDialog
          open
          close={() => setTicket(null)}
          title={`Respond: ${ticket.subject}`}
          endpoint={`/platform/support-requests/${ticket.id}`}
          method="PATCH"
          fields={[
            {
              key: 'status',
              options: ['OPEN', 'IN_PROGRESS', 'RESOLVED'],
              default: String(ticket.status),
            },
            { key: 'response', type: 'textarea', default: String(ticket.response || '') },
          ]}
        />
      )}
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
        {[
          'schools',
          'devices',
          'plans',
          'support-grants',
          'health',
          'audit',
          'organizations',
          'usage',
          'offboarding',
          'support-requests',
          'notices',
          'firmware',
        ].map((t) => (
          <button
            key={t}
            className={tab === t ? 'tab-active' : ''}
            onClick={() => {
              setTab(t);
              navigate(`/platform/${t}`);
              setPage(1);
              setSearch('');
            }}
          >
            {t.replaceAll('-', ' ')}
          </button>
        ))}
      </div>
      {tab === 'firmware' ? (
        <FirmwarePanel />
      ) : tab === 'health' ? (
        <PlatformHealth />
      ) : (
        <Panel
          title={tab.replaceAll('-', ' ')}
          action={
            tab === 'organizations' ? (
              <Button variant="outline" onClick={() => setAction('organization')}>
                Add organization
              </Button>
            ) : (
              tab === 'support-grants' && (
                <Button variant="outline" size="sm" onClick={() => setAction('grant')}>
                  Request access
                </Button>
              )
            )
          }
        >
          {tab === 'schools' && (
            <div className="table-toolbar">
              <input
                className="input max-w-sm"
                aria-label="Find school"
                placeholder="Find by name or school code…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </div>
          )}
          {query.isLoading ? (
            <Loading />
          ) : query.error ? (
            <ErrorState error={query.error} retry={() => query.refetch()} />
          ) : query.data?.data.length ? (
            <DataTable
              rows={query.data.data}
              actions={
                tab === 'audit'
                  ? (row) => (
                      <Button size="sm" variant="outline" onClick={() => setAuditChange(row)}>
                        View change
                      </Button>
                    )
                  : tab === 'schools'
                    ? (row) => (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setClosure(row);
                              setClosureAction('request');
                            }}
                          >
                            Closure request
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setCampus(row)}>
                            Campus group
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setSelected(row)}>
                            Subscription
                          </Button>
                          {(row.admin_onboarding as AdminOnboarding | undefined)?.state ===
                          'assigned' ? (
                            <span className="text-xs text-stone-600">School Admin assigned</span>
                          ) : (
                            <Button size="sm" variant="lime" onClick={() => setOnboarding(row)}>
                              {(row.admin_onboarding as AdminOnboarding | undefined)?.state ===
                              'invited'
                                ? 'Manage invitation'
                                : 'Invite School Admin'}
                            </Button>
                          )}
                        </>
                      )
                    : tab === 'plans'
                      ? (row) => (
                          <Button size="sm" variant="outline" onClick={() => setPlan(row)}>
                            Edit plan
                          </Button>
                        )
                      : tab === 'support-grants'
                        ? (row) => (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={
                                !row.approved_by ||
                                !!row.revoked_at ||
                                Date.now() >= new Date(String(row.expires_at)).getTime()
                              }
                              onClick={() => setSupport(row)}
                            >
                              Open approved access
                            </Button>
                          )
                        : tab === 'support-requests'
                          ? (row) => (
                              <Button size="sm" variant="outline" onClick={() => setTicket(row)}>
                                Respond
                              </Button>
                            )
                          : tab === 'offboarding'
                            ? (row) => (
                                <div className="flex gap-2">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={row.status !== 'APPROVED'}
                                    onClick={() => {
                                      setClosure(row);
                                      setClosureAction('close');
                                    }}
                                  >
                                    Close school
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={row.status === 'PURGED'}
                                    onClick={() => {
                                      setClosure(row);
                                      setClosureAction('hold');
                                    }}
                                  >
                                    Legal hold
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={row.status !== 'CLOSED' || !!row.legal_hold}
                                    onClick={() => {
                                      setClosure(row);
                                      setClosureAction('purge');
                                    }}
                                  >
                                    Request data deletion
                                  </Button>
                                </div>
                              )
                            : tab === 'devices'
                              ? (row) => (
                                  <div className="flex gap-2">
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      disabled={row.status === 'REVOKED'}
                                      onClick={() => {
                                        setSelected(null);
                                        setAction('rotate');
                                        setDevice(row);
                                      }}
                                    >
                                      Rotate credential
                                    </Button>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      disabled={row.status === 'REVOKED'}
                                      onClick={() => {
                                        setAction('revoke');
                                        setDevice(row);
                                      }}
                                    >
                                      Revoke
                                    </Button>
                                  </div>
                                )
                              : undefined
              }
              columns={
                tab === 'schools'
                  ? ['school_code', 'name', 'timezone', 'plan', 'subscription_status']
                  : tab === 'devices'
                    ? ['device_code', 'name', 'school_name', 'status', 'last_seen_at']
                    : tab === 'plans'
                      ? ['code', 'name', 'features', 'limits']
                      : tab === 'offboarding'
                        ? [
                            'school_name',
                            'status',
                            'policy_ref',
                            'export_until',
                            'delete_after',
                            'legal_hold',
                            'last_error',
                          ]
                        : tab === 'organizations'
                          ? ['name', 'created_at']
                          : tab === 'usage'
                            ? [
                                'school_name',
                                'on_date',
                                'active_students',
                                'devices',
                                'notifications_sent',
                              ]
                            : tab === 'audit'
                              ? ['occurred_at', 'actor_id', 'action', 'entity_type', 'reason']
                              : ['school_id', 'ticket_ref', 'reason', 'expires_at', 'approved_by']
              }
            />
          ) : (
            <Empty />
          )}
          {query.data?.total !== undefined && (
            <div className="pagination">
              <span>
                Page {page} · {query.data.total} records
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
                  disabled={page * query.data.page_size >= query.data.total}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </Panel>
      )}
      {auditChange && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setAuditChange(null);
          }}
          title="Audited platform change"
          description={String(auditChange.action)}
        >
          <dl className="grid gap-3 text-sm">
            <div>
              <dt className="field-label">Actor</dt>
              <dd className="break-all">{String(auditChange.actor_id || 'System')}</dd>
            </div>
            <div>
              <dt className="field-label">Request ID</dt>
              <dd className="break-all">{String(auditChange.request_id || '—')}</dd>
            </div>
          </dl>
          {['before', 'after'].map((key) => (
            <section className="mt-5" key={key}>
              <h3 className="field-label capitalize">{key}</h3>
              <pre className="mt-2 overflow-auto rounded-lg bg-stone-100 p-3 text-xs whitespace-pre-wrap break-all">
                {JSON.stringify(auditChange[key] ?? {}, null, 2)}
              </pre>
            </section>
          ))}
        </Dialog>
      )}
      {plan && <PlanEditor plan={plan} close={() => setPlan(null)} />}
      {support && <SupportData grant={support} close={() => setSupport(null)} />}
      {onboarding && (
        <FirstAdministratorDialog
          school={{
            id: String(onboarding.id),
            name: String(onboarding.name),
            admin_onboarding: onboarding.admin_onboarding as AdminOnboarding,
          }}
          close={() => setOnboarding(null)}
        />
      )}
      {closure && (
        <ActionDialog
          open
          close={() => setClosure(null)}
          title={
            closureAction === 'request'
              ? 'Request school closure'
              : closureAction === 'close'
                ? 'Close school and revoke readers'
                : closureAction === 'hold'
                  ? 'Change legal hold'
                  : 'Request approved school-data deletion'
          }
          endpoint={
            closureAction === 'request'
              ? `/platform/schools/${closure.id}/offboarding`
              : `/platform/offboarding/${closure.id}/${closureAction}`
          }
          timezone={String(closure.timezone || 'Asia/Kolkata')}
          fields={
            closureAction === 'request'
              ? [
                  { key: 'policy_ref' },
                  { key: 'reason', type: 'textarea' },
                  { key: 'export_until', type: 'datetime-local' },
                  { key: 'delete_after', type: 'datetime-local' },
                ]
              : closureAction === 'close'
                ? [{ key: 'confirm', type: 'hidden', default: 'CLOSE_SCHOOL' }]
                : closureAction === 'hold'
                  ? [
                      { key: 'enabled', type: 'boolean', default: String(closure.legal_hold) },
                      { key: 'policy_ref', default: String(closure.policy_ref) },
                      { key: 'reason', type: 'textarea' },
                    ]
                  : [
                      { key: 'confirm', type: 'hidden', default: 'DELETE_SCHOOL_DATA' },
                      { key: 'policy_ref', default: String(closure.policy_ref) },
                      { key: 'reason', type: 'textarea' },
                    ]
          }
          onResult={() =>
            qc.invalidateQueries({ predicate: (q) => q.queryKey.includes('platform') })
          }
        />
      )}
      {campus && (
        <ActionDialog
          open
          close={() => setCampus(null)}
          title="Assign Enterprise campus group"
          endpoint={`/platform/schools/${campus.id}/organization`}
          method="PATCH"
          fields={[
            {
              key: 'organization_id',
              lookup: '/platform/organizations',
              optional: true,
              nullable: true,
            },
            { key: 'reason', type: 'textarea' },
          ]}
        />
      )}
      {device && ['rotate', 'revoke'].includes(action) && (
        <ActionDialog
          open
          close={() => {
            setAction('');
            setDevice(null);
          }}
          title={action === 'rotate' ? 'Rotate device credential' : 'Revoke device'}
          endpoint={`/platform/devices/${device.id}/${action}`}
          fields={[{ key: 'reason', type: 'textarea' }]}
          onResult={(r) => {
            if (r?.device_secret) setResult({ ...r, device_code: device.device_code });
            qc.invalidateQueries({ predicate: (q) => q.queryKey.includes('platform') });
          }}
        />
      )}
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
      {selected && <SubscriptionEditor school={selected} close={() => setSelected(null)} />}
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
