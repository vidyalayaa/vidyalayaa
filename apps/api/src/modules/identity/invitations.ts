import { Router } from 'express';
import type pg from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { uuid, type InvitationResult, type Role } from '@vidyalayaa/contracts';
import { z } from 'zod';
import { transaction, type TenantContext } from '../../lib/db.js';
import { ApiError, asyncRoute } from '../../lib/errors.js';

export function invitationError(error: unknown): never {
  const cause = error as { code?: string; message?: string };
  const messages: Record<string, [number, string]> = {
    ONBOARDING_NOT_ALLOWED: [
      403,
      'This school already has an administrator, or you cannot manage its invitations.',
    ],
    MEMBERSHIP_EXISTS: [
      409,
      'This account already belongs to the school. Use Manage members to change its role.',
    ],
    INVITATION_IN_PROGRESS: [
      409,
      'This invitation is being prepared. Wait a moment before retrying.',
    ],
    INVITATION_CHANGED: [409, 'The invitation changed. Refresh the page before trying again.'],
    INVITATION_NOT_FOUND: [
      404,
      'This invitation is unavailable, expired, or was already answered.',
    ],
    INVITATION_RECORD_REQUIRED: [
      422,
      'Choose an existing school record. Cancel and reissue older invitations without a record.',
    ],
    INVITATION_RECORD_UNAVAILABLE: [
      422,
      'Choose an active record in this school with the matching email and role.',
    ],
    INVITATION_RECORD_LINKED: [409, 'This record is already linked to a different account.'],
    INVITATION_RECORD_BUSY: [
      409,
      'This record already has a pending invitation. Cancel it before changing the recipient.',
    ],
    PARENT_CHILD_REQUIRED: [422, 'Link this parent to their child before inviting them.'],
    FORBIDDEN: [403, 'Your account cannot manage this invitation.'],
    IDENTITY_MISMATCH: [409, 'The invited identity could not be verified. Retry the invitation.'],
  };
  const mapped = messages[cause.message || ''];
  if (mapped) throw new ApiError(mapped[0], cause.message!, mapped[1]);
  throw error;
}

export async function inviteMember(
  pool: pg.Pool,
  context: TenantContext,
  auth: SupabaseClient,
  input: { school_id: string; email: string; full_name: string; role: Role; record_id?: string },
  redirectTo: string,
  resend = false,
): Promise<InvitationResult> {
  let intent: {
    id: string;
    attempt_id: string;
    action: 'none' | 'send' | 'link';
    user_id?: string;
    status: string;
    full_name?: string;
  };
  try {
    intent = await transaction(
      pool,
      context,
      async (tx) =>
        (
          await tx.query('SELECT app.begin_school_invitation($1,$2,$3,$4,$5,$6) AS result', [
            input.school_id,
            input.email,
            input.full_name,
            input.role,
            resend,
            input.record_id ?? null,
          ])
        ).rows[0].result,
    );
  } catch (error) {
    return invitationError(error);
  }
  if (intent.action === 'none') return { id: intent.id, status: intent.status, email_sent: false };
  try {
    let identity = intent.user_id;
    if (intent.action === 'send') {
      const response = await auth.auth.admin.inviteUserByEmail(input.email, {
        data: { full_name: intent.full_name || input.full_name },
        redirectTo,
      });
      if (response.error || !response.data.user) {
        throw new ApiError(
          422,
          'INVITATION_EMAIL_FAILED',
          'The setup email could not be sent. Check the Auth email provider and retry this invitation.',
        );
      }
      identity = response.data.user.id;
    }
    if (!identity)
      throw new ApiError(
        409,
        'IDENTITY_MISMATCH',
        'The invited account was not found. Retry the invitation.',
      );
    return await transaction(
      pool,
      context,
      async (tx) =>
        (
          await tx.query('SELECT app.finish_school_invitation($1,$2,$3,$4) AS result', [
            intent.id,
            intent.attempt_id,
            identity,
            intent.action === 'send',
          ])
        ).rows[0].result,
    );
  } catch (error) {
    await transaction(pool, context, (tx) =>
      tx.query('SELECT app.fail_school_invitation($1,$2)', [intent.id, intent.attempt_id]),
    ).catch(() => {});
    return invitationError(error);
  }
}

// Authenticated recipients can answer an invitation before they have any school.
export function recipientInvitationRouter(pool: pg.Pool) {
  const r = Router();
  r.get(
    '/pending',
    asyncRoute(async (_req, res) => {
      res.json(
        await transaction(
          pool,
          res.locals.actor.context,
          async (tx) => ({
            data: (await tx.query('SELECT * FROM app.pending_school_invitations()')).rows,
          }),
          true,
        ),
      );
    }),
  );
  r.post(
    '/:id/respond',
    asyncRoute(async (req, res) => {
      const id = uuid.parse(req.params.id);
      const { accept } = z.object({ accept: z.boolean() }).strict().parse(req.body);
      try {
        res.json(
          await transaction(
            pool,
            res.locals.actor.context,
            async (tx) =>
              (
                await tx.query('SELECT app.respond_school_invitation($1,$2) AS result', [
                  id,
                  accept,
                ])
              ).rows[0].result,
          ),
        );
      } catch (error) {
        invitationError(error);
      }
    }),
  );
  return r;
}
