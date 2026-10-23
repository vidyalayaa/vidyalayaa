import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Layers3 } from 'lucide-react';
import { enablePush } from '../../lib/push';
import { configured, useAuth } from '../../lib/auth';
import { resourceInfo } from '../resources/metadata';
import { Button } from '../../components/ui/button';
import { PageHeading, Panel, Badge } from '../../components/common';
import { ActionDialog } from '../../components/ActionDialog';
import AuthenticatorSetup from '../auth/AuthenticatorSetup';
import PendingInvitations from '../auth/PendingInvitations';
import { FamilyProfile } from './SchoolTools';
import NotificationPrivacy from './NotificationPrivacy';
import SecurityPolicy from './SecurityPolicy';
import RetentionPanel from './RetentionPanel';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/auth';
import { label, display } from '../../lib/utils';
import { Loading, ErrorState } from '../../components/common';
export default function Settings() {
  const a = useAuth(),
    [error, setError] = useState(''),
    [success, setSuccess] = useState(''),
    [profile, setProfile] = useState(false),
    plan = useQuery({
      queryKey: [a.school, 'subscription'],
      queryFn: () =>
        api<{
          plan_name: string;
          subscription_status: string;
          features: Record<string, boolean>;
          limits: Record<string, number>;
          current_period_end: string | null;
          grace_ends_at: string | null;
        }>('/subscription'),
      enabled: configured && !!a.me?.school?.permissions.includes('subscription.read'),
    });
  return (
    <>
      <PageHeading
        title="Make it your school."
        description="The foundations, preferences, and security of your workspace."
      />
      <div className="settings-grid">
        <Panel title="Workspace connection" subtitle="Everything starts with a secure foundation.">
          <div className="settings-body">
            <div className="setting-line">
              <span>School workspace</span>
              <Badge>{configured ? 'CONFIGURED' : 'SETUP_REQUIRED'}</Badge>
            </div>
            <div className="setting-line">
              <span>Authenticated account</span>
              <strong>{a.me?.email || 'Not connected'}</strong>
            </div>
            {a.me?.school && (
              <>
                <div className="setting-line">
                  <span>School name</span>
                  <strong>{a.me.school.school_name}</strong>
                </div>
                <div className="setting-line">
                  <span>School timezone</span>
                  <strong>{a.me.school.timezone}</strong>
                </div>
                <div className="setting-line">
                  <span>School language</span>
                  <strong>{a.me.locale === 'hi-IN' ? 'Hindi' : 'English'}</strong>
                </div>
              </>
            )}
            <div className="setting-line">
              <span>Current subscription</span>
              <strong>{a.me?.subscription_status || 'Awaiting setup'}</strong>
            </div>
            {!configured && (
              <p className="mt-5 text-sm leading-6 text-stone-500">
                Connect Supabase authentication and the API using the environment examples in your
                source code. Add a school and invite its first administrator, then sign in to start
                your school’s workspace.
              </p>
            )}
            <div className="mt-5 flex flex-wrap gap-2">
              {a.me?.school?.role === 'parent' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    enablePush()
                      .then(() => setSuccess('Browser notifications enabled.'))
                      .catch((e) => setError(e.message))
                  }
                >
                  Enable browser notifications
                </Button>
              )}
              {a.me?.school?.permissions.includes('school.manage') && (
                <Button variant="outline" size="sm" onClick={() => setProfile(true)}>
                  School profile
                </Button>
              )}
              {a.me?.school?.permissions.includes('users.manage') && (
                <Button asChild variant="outline" size="sm">
                  <Link to="/members">
                    Manage members <ArrowUpRight size={14} />
                  </Link>
                </Button>
              )}
              {a.me?.school?.permissions.includes('audit.read') && (
                <Button asChild variant="outline" size="sm">
                  <Link to="/audit">
                    Audit history <ArrowUpRight size={14} />
                  </Link>
                </Button>
              )}
              {a.me?.school?.permissions.includes('users.manage') && (
                <Button asChild variant="outline" size="sm">
                  <Link to="/support">
                    Support access <ArrowUpRight size={14} />
                  </Link>
                </Button>
              )}
            </div>
            {error && (
              <p className="field-error mt-3" role="alert">
                {error}
              </p>
            )}
            {success && (
              <p className="mt-3 text-sm text-green-800" role="status">
                {success}
              </p>
            )}
          </div>
        </Panel>
        <Panel title="Account security" subtitle="A little extra protection goes a long way.">
          <div className="px-6 pt-4">
            <Button asChild variant="outline">
              <Link to="/settings/security">
                Security &amp; Login Sessions <ArrowUpRight size={16} />
              </Link>
            </Button>
          </div>
          <AuthenticatorSetup />
        </Panel>
      </div>
      {a.me?.school?.permissions.includes('school.manage') && <SecurityPolicy />}
      {a.me?.school?.role === 'parent' && <NotificationPrivacy />}
      <FamilyProfile />
      <PendingInvitations />
      {a.me?.school?.permissions.includes('school.manage') && <RetentionPanel />}
      {a.me?.school?.permissions.includes('subscription.read') && (
        <Panel
          title="Your school plan"
          subtitle="Included features and the limits applied to this school."
        >
          <div className="settings-body">
            {plan.isLoading ? (
              <Loading />
            ) : plan.error ? (
              <ErrorState error={plan.error} retry={() => plan.refetch()} />
            ) : (
              plan.data && (
                <>
                  <div className="setting-line">
                    <strong>{plan.data.plan_name}</strong>
                    <Badge>{plan.data.subscription_status}</Badge>
                  </div>
                  {plan.data.current_period_end && (
                    <div className="setting-line">
                      <span>Current period ends</span>
                      <span>{display(plan.data.current_period_end, a.me?.school?.timezone)}</span>
                    </div>
                  )}
                  <div className="grid gap-8 py-5 sm:grid-cols-2">
                    <div>
                      <h3 className="mb-3 font-semibold">Features</h3>
                      {Object.entries(plan.data.features).map(([key, value]) => (
                        <div className="setting-line" key={key}>
                          <span>{label(key)}</span>
                          <span>{value ? 'Included' : 'Unavailable'}</span>
                        </div>
                      ))}
                    </div>
                    <div>
                      <h3 className="mb-3 font-semibold">Limits</h3>
                      {Object.entries(plan.data.limits).map(([key, value]) => (
                        <div className="setting-line" key={key}>
                          <span>{label(key)}</span>
                          <strong>{String(value)}</strong>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )
            )}
          </div>
        </Panel>
      )}
      <Panel
        title="Explore your workspace"
        subtitle="Find the tools for every part of the school day."
      >
        <div className="module-grid">
          {Object.entries(resourceInfo)
            .filter(([, v]) => !configured || a.me?.school?.permissions.includes(v.permission))
            .map(([key, v]) => (
              <Link key={key} to={`/r/${key}`}>
                <span className="module-icon">
                  <Layers3 size={18} />
                </span>
                <div>
                  <h3>{v.title}</h3>
                  <p>{v.description}</p>
                </div>
                <ArrowUpRight size={16} />
              </Link>
            ))}
        </div>
      </Panel>
      <ActionDialog
        open={profile}
        close={() => setProfile(false)}
        title="School profile"
        endpoint="/school"
        method="PATCH"
        onResult={() => a.refetch()}
        fields={[
          { key: 'name', default: a.me?.school?.school_name },
          { key: 'timezone', default: a.me?.school?.timezone },
          { key: 'locale', options: ['en-IN', 'hi-IN'], default: a.me?.locale || 'en-IN' },
        ]}
      />
    </>
  );
}
