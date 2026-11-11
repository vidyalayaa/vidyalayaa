import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  firstAdminSchema,
  type AdminOnboarding,
  type InvitationResult,
} from '@vidyalayaa/contracts';
import type { z } from 'zod';
import { api } from '../../lib/auth';
import { Dialog } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';

export default function FirstAdministratorDialog({
  school,
  close,
}: {
  school: { id: string; name: string; admin_onboarding?: AdminOnboarding };
  close: () => void;
}) {
  const qc = useQueryClient();
  const [result, setResult] = useState<InvitationResult | null>(null);
  const form = useForm<z.input<typeof firstAdminSchema>, unknown, z.output<typeof firstAdminSchema>>({
    resolver: zodResolver(firstAdminSchema),
    defaultValues: {
      email: school.admin_onboarding?.email || '',
      full_name: school.admin_onboarding?.full_name || '',
      resend: school.admin_onboarding?.state === 'invited',
    },
  });
  const invite = useMutation({
    mutationFn: (body: z.infer<typeof firstAdminSchema>) =>
      api<InvitationResult>(`/platform/schools/${school.id}/administrator-invitation`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: (value) => {
      setResult(value);
      qc.invalidateQueries({ predicate: (query) => query.queryKey.includes('platform') });
    },
  });
  const cancel = useMutation({
    mutationFn: () =>
      api(
        `/platform/schools/${school.id}/administrator-invitation/${school.admin_onboarding?.invitation_id}/cancel`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ predicate: (query) => query.queryKey.includes('platform') });
      close();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={`School Admin for ${school.name}`}
      description="Invite the school's first administrator. They choose their own password and accept access to this school."
    >
      {result ? (
        <div className="space-y-4">
          <p role="status" className="notice">
            {result.status === 'READY'
              ? 'This person already has an account. They can sign in with their existing password and accept the school invitation in Settings.'
              : result.email_sent
                ? 'The setup email has been sent. The recipient can choose a password, then accept the school invitation.'
                : 'An invitation is already waiting for this person. They can accept it after signing in.'}
          </p>
          <Button variant="lime" onClick={close}>
            Done
          </Button>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={form.handleSubmit((value) => invite.mutate(value))}>
          <div>
            <label className="field-label" htmlFor="first-admin-name">
              Full name
            </label>
            <input
              id="first-admin-name"
              className="input"
              autoComplete="name"
              {...form.register('full_name')}
              required
            />
            {form.formState.errors.full_name && (
              <p className="field-error">{form.formState.errors.full_name.message}</p>
            )}
          </div>
          <div>
            <label className="field-label" htmlFor="first-admin-email">
              Email address
            </label>
            <input
              id="first-admin-email"
              className="input"
              type="email"
              autoComplete="email"
              {...form.register('email')}
              required
            />
            {form.formState.errors.email && (
              <p className="field-error">{form.formState.errors.email.message}</p>
            )}
          </div>
          <p className="text-sm text-stone-600">
            Role: School Admin. Further school accounts, including the Principal, are managed by
            this administrator.
          </p>
          {(invite.error || cancel.error) && (
            <p className="field-error" role="alert">
              {(invite.error || cancel.error)?.message}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {school.admin_onboarding?.invitation_id && (
              <Button
                type="button"
                variant="outline"
                disabled={invite.isPending || cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                Cancel invitation
              </Button>
            )}
            <Button variant="lime" disabled={invite.isPending || cancel.isPending}>
              {invite.isPending
                ? 'Preparing invitation…'
                : school.admin_onboarding?.state === 'invited'
                  ? 'Resend invitation'
                  : 'Invite School Admin'}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
