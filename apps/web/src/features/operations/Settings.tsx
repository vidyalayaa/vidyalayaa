import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowUpRight,
  ShieldCheck,
  Layers3,
  KeyRound,
  Check,
  Settings2,
  BookOpen,
  Users,
} from 'lucide-react';
import { enablePush } from '../../lib/push';
import { configured, useAuth, supabase } from '../../lib/auth';
import { resourceInfo } from '../resources/metadata';
import { Button } from '../../components/ui/button';
import { PageHeading, Panel, Badge } from '../../components/common';
import { ActionDialog } from '../../components/ActionDialog';
export default function Settings() {
  const a = useAuth(),
    [qr, setQr] = useState(''),
    [factor, setFactor] = useState(''),
    [error, setError] = useState(''),
    [success, setSuccess] = useState(''),
    [profile, setProfile] = useState(false);
  async function enroll() {
    if (!supabase) return;
    const r = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'Vidyalayaa authenticator',
    });
    if (r.error) {
      setError(r.error.message);
      return;
    }
    setQr(r.data.totp.qr_code);
    setFactor(r.data.id);
  }
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
          </div>
        </Panel>
        <Panel title="Account security" subtitle="A little extra protection goes a long way.">
          <div className="settings-body">
            <div className="security-heading">
              <span>
                <ShieldCheck size={25} />
              </span>
              <div>
                <h3>Multi-factor authentication</h3>
                <p>Protect your account with an authenticator app.</p>
              </div>
            </div>
            <Button variant="outline" disabled={!a.session} onClick={enroll}>
              <KeyRound size={15} />
              Set up authenticator
            </Button>
            {qr && (
              <div className="mt-5">
                <img
                  alt="Scan this QR code with your authenticator app"
                  src={`data:image/svg+xml,${encodeURIComponent(qr)}`}
                  width={180}
                  height={180}
                />
                <form
                  className="mt-4 flex gap-2"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const code = String(new FormData(e.currentTarget).get('code'));
                    const r = await supabase!.auth.mfa.challengeAndVerify({
                      factorId: factor,
                      code,
                    });
                    if (r.error) setError(r.error.message);
                    else {
                      setSuccess('Authenticator enabled.');
                      setQr('');
                    }
                  }}
                >
                  <input
                    name="code"
                    aria-label="Authenticator code"
                    className="input"
                    pattern="[0-9]{6}"
                    inputMode="numeric"
                    required
                  />
                  <Button variant="lime">Verify</Button>
                </form>
              </div>
            )}
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
      </div>
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
        fields={[
          { key: 'name', default: a.me?.school?.school_name },
          { key: 'timezone', default: a.me?.school?.timezone },
        ]}
      />
    </>
  );
}
