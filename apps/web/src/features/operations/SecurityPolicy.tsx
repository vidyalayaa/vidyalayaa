import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, useAuth } from '../../lib/auth';
import { Panel, Loading, ErrorState } from '../../components/common';
import { Button } from '../../components/ui/button';
interface Policy {
  require_privileged_mfa: boolean;
  student_login_enabled: boolean;
  step_up_sensitive: boolean;
  device_offline_minutes: number;
  policy_ref: string;
}
export default function SecurityPolicy() {
  const a = useAuth(),
    qc = useQueryClient(),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false),
    q = useQuery({
      queryKey: [a.school, 'security-policy'],
      queryFn: () => api<Policy>('/school/security'),
    });
  return (
    <Panel
      title="School security policy"
      subtitle="Require an authenticator for school leaders and control student sign-in. Keep a verified recovery process before enforcing MFA."
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : (
        q.data && (
          <form
            className="settings-body space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              setSaving(true);
              setError('');
              try {
                await api('/school/security', {
                  method: 'PUT',
                  body: JSON.stringify({
                    require_privileged_mfa: f.has('mfa'),
                    student_login_enabled: f.has('student'),
                    step_up_sensitive: f.has('step'),
                    device_offline_minutes: Number(f.get('offline')),
                    policy_ref: String(f.get('ref')),
                  }),
                });
                qc.invalidateQueries({ queryKey: [a.school] });
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setSaving(false);
              }
            }}
          >
            <label className="flex gap-3">
              <input type="checkbox" name="mfa" defaultChecked={q.data.require_privileged_mfa} />
              Require MFA for School Admins and Principals
            </label>
            <label className="flex gap-3">
              <input type="checkbox" name="student" defaultChecked={q.data.student_login_enabled} />
              Allow invited student accounts to sign in
            </label>
            <label className="flex gap-3">
              <input type="checkbox" name="step" defaultChecked={q.data.step_up_sensitive} />
              Require recent verification for sensitive changes
            </label>
            <label className="field-label block">
              Reader offline threshold (minutes)
              <input
                className="input mt-2"
                type="number"
                min="1"
                max="60"
                name="offline"
                defaultValue={q.data.device_offline_minutes}
                required
              />
            </label>
            <label className="field-label block">
              Policy approval reference
              <input
                className="input mt-2"
                name="ref"
                minLength={5}
                maxLength={200}
                defaultValue={q.data.policy_ref}
                required
              />
            </label>
            {error && (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}
            <Button variant="lime" disabled={saving}>
              {saving ? 'Saving…' : 'Save security policy'}
            </Button>
          </form>
        )
      )}
    </Panel>
  );
}
