import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import {
  pageSchema,
  resourceNames,
  resourceSchemas,
  manualSchema,
  correctionSchema,
  reportSchema,
  inviteSchema,
  uuid,
  type Resource,
  retentionPolicySchema,
} from '@vidyalayaa/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { inviteMember, invitationError } from '../identity/invitations.js';
import { asyncRoute, ApiError, notFound } from '../../lib/errors.js';
import { paged, cursorPage } from '../../lib/pagination.js';
import { transaction, audit, type Tx } from '../../lib/db.js';
import { permission, loadEntitlements, type Actor } from '../../middleware/auth.js';
import {
  definitions,
  resourceScope,
  resourceSelect,
  parseResource,
  validateBusiness,
  studentScope,
  classScope,
  assertStudent,
  assertClass,
} from './resources.js';
import { queue } from '../attendance/service.js';
import { localParts } from '../attendance/engine.js';
import { signedDownload, verifyDownload } from '../../lib/downloads.js';
import { hash, encrypt } from '../../lib/crypto.js';
import type { Config } from '../../lib/config.js';
const validName = (s: string) => {
  if (!resourceNames.includes(s as Resource)) throw notFound();
  return s as Resource;
};
export async function requireWrite(tx: Tx, a: Actor, feature?: string) {
  const s = (
    await tx.query(
      'SELECT s.status,p.features FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE school_id=$1 ORDER BY s.created_at DESC LIMIT 1',
      [a.context.schoolId],
    )
  ).rows[0];
  if (!s || !['TRIALING', 'ACTIVE', 'PAST_DUE'].includes(s.status))
    throw new ApiError(403, 'SUBSCRIPTION_READONLY', 'This subscription permits read access only.');
  if (feature && !s.features[feature])
    throw new ApiError(
      403,
      'SUBSCRIPTION_FEATURE_UNAVAILABLE',
      'Your current plan does not include this feature.',
    );
}
export async function withIdempotency<T>(
  tx: Tx,
  a: Actor,
  key: string | undefined,
  body: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  if (!key) return fn();
  if (!/^[a-zA-Z0-9:_-]{8,200}$/.test(key))
    throw new ApiError(422, 'INVALID_IDEMPOTENCY_KEY', 'Use an 8-200 character idempotency key.');
  const fingerprint = hash(JSON.stringify(body));
  const r = await tx.query(
    "INSERT INTO api_idempotency_keys(school_id,user_id,key,request_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '24 hours') ON CONFLICT(school_id,user_id,key) DO NOTHING RETURNING id",
    [a.context.schoolId, a.id, key, fingerprint],
  );
  if (!r.rowCount) {
    const old = (
      await tx.query(
        'SELECT request_hash,response FROM api_idempotency_keys WHERE school_id=$1 AND user_id=$2 AND key=$3',
        [a.context.schoolId, a.id, key],
      )
    ).rows[0];
    if (old.request_hash !== fingerprint)
      throw new ApiError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'This key was already used for a different request.',
      );
    return old.response as T;
  }
  const result = await fn();
  await tx.query('UPDATE api_idempotency_keys SET response=$2 WHERE id=$1', [r.rows[0].id, result]);
  return result;
}
export function schoolAccess(pool: pg.Pool) {
  return asyncRoute(async (req, res, next) => {
    const a = res.locals.actor;
    Object.assign(a, await loadEntitlements(pool, a));
    if (
      ['SUSPENDED', 'CANCELLED', 'EXPIRED'].includes(a.subscription_status || '') &&
      !(
        a.active!.role === 'school_admin' &&
        (req.path.startsWith('/reports') ||
          req.path === '/subscription' ||
          req.path === '/school/retention')
      )
    )
      throw new ApiError(
        403,
        'SUBSCRIPTION_RESTRICTED',
        'School administrator billing and data export access only.',
      );
    next();
  });
}
export function schoolRouter(pool: pg.Pool, storage: SupabaseClient, config: Config) {
  const router = Router();
  router.get(
    '/school/retention',
    permission('school.manage'),
    asyncRoute(async (_req, res) => {
      const a = res.locals.actor;
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => ({
            policy:
              (
                await tx.query("SELECT settings->'retention' AS policy FROM schools WHERE id=$1", [
                  a.context.schoolId,
                ])
              ).rows[0]?.policy || null,
            plan_report_days: a.limits.report_retention_days ?? 180,
          }),
          true,
        ),
      );
    }),
  );
  router.delete(
    '/school/retention',
    permission('school.manage'),
    asyncRoute(async (_req, res) => {
      const a = res.locals.actor;
      await transaction(pool, a.context, async (tx) => {
        await tx.query("UPDATE schools SET settings=settings-'retention' WHERE id=$1", [
          a.context.schoolId,
        ]);
        await audit(
          tx,
          a.context.schoolId,
          a.id,
          'retention.policy.disabled',
          'schools',
          a.context.schoolId,
        );
      });
      res.status(204).end();
    }),
  );
  router.put(
    '/school/retention',
    permission('school.manage'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = retentionPolicySchema.parse(req.body);
      res.json(
        await transaction(pool, a.context, async (tx) => {
          await requireWrite(tx, a);
          const policy = {
            policy_ref: b.policy_ref,
            report_days: b.report_days,
            notification_days: b.notification_days,
            approved_by: a.id,
            approved_at: new Date().toISOString(),
          };
          await tx.query(
            "UPDATE schools SET settings=jsonb_set(settings,'{retention}',$2::jsonb) WHERE id=$1",
            [a.context.schoolId, JSON.stringify(policy)],
          );
          await audit(
            tx,
            a.context.schoolId,
            a.id,
            'retention.policy.approved',
            'schools',
            a.context.schoolId,
          );
          return { policy };
        }),
      );
    }),
  );
  router.get(
    '/support-access',
    asyncRoute(async (_req, res) => {
      const a = res.locals.actor;
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => ({
            data: (
              await tx.query(
                'SELECT ticket_ref,expires_at,scope FROM support_access_grants WHERE school_id=$1 AND approved_by IS NOT NULL AND revoked_at IS NULL AND starts_at<=now() AND expires_at>now() ORDER BY expires_at',
                [a.context.schoolId],
              )
            ).rows,
          }),
          true,
        ),
      );
    }),
  );
  router.patch(
    '/school',
    permission('school.manage'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = z
          .object({
            name: z.string().min(2).max(200),
            timezone: z.string().max(100),
            locale: z.enum(['en-IN', 'hi-IN']).optional(),
          })
          .strict()
          .parse(req.body);
      try {
        new Intl.DateTimeFormat('en', { timeZone: b.timezone }).format();
      } catch {
        throw new ApiError(422, 'INVALID_TIMEZONE', 'Use an IANA timezone.');
      }
      res.json(
        await transaction(pool, a.context, async (tx) => {
          await requireWrite(tx, a);
          return (
            await tx.query(
              "UPDATE schools SET name=$2,timezone=$3,settings=settings||CASE WHEN $4::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('locale',$4::text) END WHERE id=$1 RETURNING name,timezone,settings",
              [a.context.schoolId, b.name, b.timezone, b.locale || null],
            )
          ).rows[0];
        }),
      );
    }),
  );
  router.get(
    '/profile/parent',
    permission('notifications.preferences'),
    asyncRoute(async (_req, res) => {
      const a = res.locals.actor;
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => ({
            data: (
              await tx.query(
                "SELECT id,full_name FROM parents WHERE school_id=$1 AND user_id=$2 AND status='ACTIVE'",
                [a.context.schoolId, a.id],
              )
            ).rows,
          }),
          true,
        ),
      );
    }),
  );
  router.get(
    '/dashboard',
    asyncRoute(async (_req, res) => {
      const a = res.locals.actor;
      const data = await transaction(
        pool,
        a.context,
        async (tx) => {
          const date = localParts(new Date(), a.active!.timezone).date;
          const stats = (
            await tx.query(
              `SELECT count(*)::int AS students,count(*) FILTER(WHERE d.attendance_status IN ('PRESENT','LATE','HALF_DAY'))::int AS present,count(*) FILTER(WHERE d.attendance_status='LATE')::int AS late,count(*) FILTER(WHERE d.attendance_status='ABSENT')::int AS absent FROM students t LEFT JOIN daily_attendance d ON d.school_id=t.school_id AND d.student_id=t.id AND d.attendance_date=$3 WHERE t.school_id=$1 AND t.status='ACTIVE' AND ${studentScope(a, 't.id', '$2')}`,
              [a.context.schoolId, a.id, date],
            )
          ).rows[0];
          const trend = (
            await tx.query(
              `SELECT t.attendance_date::text AS date,count(*) FILTER(WHERE t.attendance_status IN ('PRESENT','LATE','HALF_DAY'))::int AS present,count(*)::int AS total FROM daily_attendance t WHERE t.school_id=$1 AND t.attendance_date BETWEEN $3::date-6 AND $3::date AND ${studentScope(a, 't.student_id', '$2')} GROUP BY t.attendance_date ORDER BY t.attendance_date`,
              [a.context.schoolId, a.id, date],
            )
          ).rows;
          const recent = (
            await tx.query(
              `SELECT t.id,t.attendance_status,t.movement_status,t.first_arrival_at,t.last_departure_at,t.needs_review,s.first_name,s.last_name,s.student_code FROM daily_attendance t JOIN students s ON s.school_id=t.school_id AND s.id=t.student_id WHERE t.school_id=$1 AND t.attendance_date=$3 AND ${studentScope(a, 't.student_id', '$2')} ORDER BY t.updated_at DESC LIMIT 6`,
              [a.context.schoolId, a.id, date],
            )
          ).rows;
          const notices = (
            await tx.query(
              `SELECT t.id,t.title,t.body,t.published_at,t.audience FROM announcements t WHERE t.school_id=$1 AND t.published_at<=now() AND ${resourceScope('announcements', a)} ORDER BY t.published_at DESC LIMIT 4`,
              [a.context.schoolId, a.id],
            )
          ).rows;
          const deviceHealth = a.active!.permissions.includes('devices.read')
            ? (
                await tx.query(
                  "SELECT count(*)::int AS total,count(*) FILTER(WHERE status='ACTIVE' AND last_seen_at>now()-interval '3 minutes')::int AS online,coalesce(sum(pending_event_count),0)::int AS pending FROM devices WHERE school_id=$1",
                  [a.context.schoolId],
                )
              ).rows[0]
            : null;
          return { date, stats, trend, recent, notices, deviceHealth };
        },
        true,
      );
      res.json(data);
    }),
  );
  router.get(
    '/lookups/accounts',
    permission('users.manage'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        q = pageSchema.parse(req.query),
        role = z.enum(['teacher', 'parent', 'student']).parse(req.query.role);
      const result = await transaction(
        pool,
        a.context,
        async (tx) => {
          const args = [a.context.schoolId, role, `%${q.search || ''}%`];
          const where =
            "m.school_id=$1 AND r.code=$2 AND m.status='ACTIVE' AND u.status='ACTIVE' AND (u.full_name ILIKE $3 OR u.email::text ILIKE $3)";
          const total = Number(
            (
              await tx.query(
                `SELECT count(*) FROM school_memberships m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id WHERE ${where}`,
                args,
              )
            ).rows[0].count,
          );
          const data = (
            await tx.query(
              `SELECT u.id,u.full_name,u.email FROM school_memberships m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id WHERE ${where} ORDER BY u.full_name,u.id LIMIT $4 OFFSET $5`,
              [...args, q.page_size, (q.page - 1) * q.page_size],
            )
          ).rows;
          return { data, total, page: q.page, page_size: q.page_size };
        },
        true,
      );
      res.json(result);
    }),
  );
  router.get(
    '/resources/:resource',
    asyncRoute(async (req, res) => {
      const name = validName(String(req.params.resource)),
        d = definitions[name],
        a = res.locals.actor;
      if (!a.active!.permissions.includes(d.read))
        throw new ApiError(403, 'FORBIDDEN', 'You cannot view these records.');
      if (d.feature && !a.features[d.feature])
        throw new ApiError(
          403,
          'SUBSCRIPTION_FEATURE_UNAVAILABLE',
          'Your plan does not include this module.',
        );
      const q = pageSchema.parse(req.query);
      const result = await transaction(
        pool,
        a.context,
        async (tx) => {
          const params: unknown[] = [a.context.schoolId, a.id];
          let where = `t.school_id=$1 AND ${resourceScope(name, a)}`;
          if (q.search && d.search.length) {
            params.push(`%${q.search.replace(/[\\%_]/g, '\\$&')}%`);
            where += ` AND (${d.search.map((c) => `t.${c}::text ILIKE $${params.length}`).join(' OR ')})`;
          }
          if (
            q.class_id &&
            ['enrollments', 'exams', 'assignments', 'timetable_entries'].includes(name)
          ) {
            params.push(q.class_id);
            where += ` AND t.class_id=$${params.length}`;
          }
          const total = Number(
            (await tx.query(`SELECT count(*) FROM ${name} t WHERE ${where}`, params)).rows[0].count,
          );
          const list = await tx.query(
            `SELECT ${resourceSelect(name)} FROM ${name} t WHERE ${where} ORDER BY t.created_at DESC,t.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, q.page_size, (q.page - 1) * q.page_size],
          );
          return { data: list.rows, total, page: q.page, page_size: q.page_size };
        },
        true,
      );
      res.json(result);
    }),
  );
  router.get(
    '/resources/:resource/:id',
    asyncRoute(async (req, res) => {
      const name = validName(String(req.params.resource)),
        a = res.locals.actor;
      if (!a.active!.permissions.includes(definitions[name].read))
        throw new ApiError(403, 'FORBIDDEN', 'Access denied.');
      if (definitions[name].feature && !a.features[definitions[name].feature!])
        throw new ApiError(
          403,
          'SUBSCRIPTION_FEATURE_UNAVAILABLE',
          'Your plan does not include this module.',
        );
      const id = uuid.parse(req.params.id);
      const row = await transaction(
        pool,
        a.context,
        async (tx) =>
          (
            await tx.query(
              `SELECT ${resourceSelect(name)} FROM ${name} t WHERE t.school_id=$1 AND t.id=$3 AND ${resourceScope(name, a)}`,
              [a.context.schoolId, a.id, id],
            )
          ).rows[0],
        true,
      );
      if (!row) throw notFound();
      res.json(row);
    }),
  );
  router.post(
    '/resources/:resource',
    asyncRoute(async (req, res) => {
      const name = validName(String(req.params.resource)),
        d = definitions[name],
        a = res.locals.actor;
      if (!d.write || !a.active!.permissions.includes(d.write))
        throw new ApiError(403, 'FORBIDDEN', 'You cannot create these records.');
      const values = parseResource(name, req.body);
      const row = await transaction(pool, a.context, async (tx) => {
        await requireWrite(tx, a, d.feature);
        return withIdempotency(tx, a, req.header('Idempotency-Key'), { name, values }, async () => {
          // Serialize count limits, scheduling conflicts and session/rule changes at the school boundary.
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            `${a.context.schoolId}:${name}`,
          ]);
          await validateBusiness(tx, a, name, values, false);
          if (name === 'students') {
            const n = Number(
              (
                await tx.query(
                  "SELECT count(*) FROM students WHERE school_id=$1 AND status='ACTIVE'",
                  [a.context.schoolId],
                )
              ).rows[0].count,
            );
            if (n >= (a.limits.max_students ?? 0))
              throw new ApiError(409, 'PLAN_LIMIT_REACHED', 'The student limit has been reached.');
          }
          if (name === 'academic_sessions' && values.is_current)
            await tx.query(
              'UPDATE academic_sessions SET is_current=false WHERE school_id=$1 AND is_current',
              [a.context.schoolId],
            );
          if (name === 'attendance_rule_versions')
            await tx.query(
              'UPDATE attendance_rule_versions SET effective_to=$4 WHERE school_id=$1 AND class_id IS NOT DISTINCT FROM $2::uuid AND day_type=$3 AND effective_to IS NULL AND effective_from<$4',
              [a.context.schoolId, values.class_id || null, values.day_type, values.effective_from],
            );
          if (['assignments', 'announcements', 'attendance_rule_versions'].includes(name))
            values.created_by = a.id;
          if (name === 'marks') values.entered_by = a.id;
          if (name === 'nfc_cards') values.issued_by = a.id;
          const keys = Object.keys(values);
          const row = (
            await tx.query(
              `INSERT INTO ${name}(school_id,${keys.join(',')}) VALUES($1,${keys.map((_, i) => `$${i + 2}`).join(',')}) RETURNING *`,
              [a.context.schoolId, ...keys.map((k) => values[k])],
            )
          ).rows[0];
          if (name === 'announcements' && values.published_at)
            await queue(tx, a.context.schoolId, null, 'ANNOUNCEMENT', `ANNOUNCEMENT:${row.id}`, {
              announcement_id: row.id,
              class_id: row.class_id,
              audience: row.audience,
              title: row.title,
              event_time: row.published_at,
            });
          await audit(tx, a.context.schoolId, a.id, `${name}.create`, name, row.id);
          return row;
        });
      });
      res.status(201).json(row);
    }),
  );
  router.patch(
    '/resources/:resource/:id',
    asyncRoute(async (req, res) => {
      const name = validName(String(req.params.resource)),
        d = definitions[name],
        a = res.locals.actor;
      if (!d.write || !a.active!.permissions.includes(d.write))
        throw new ApiError(403, 'FORBIDDEN', 'You cannot update these records.');
      if (d.immutable) throw new ApiError(409, 'IMMUTABLE_VERSION', 'Create a new rule version.');
      const id = uuid.parse(req.params.id),
        patch = resourceSchemas[name].partial().parse(req.body) as Record<string, unknown>;
      const row = await transaction(pool, a.context, async (tx) => {
        await requireWrite(tx, a, d.feature);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `${a.context.schoolId}:${name}`,
        ]);
        const old = (
          await tx.query(
            `SELECT t.* FROM ${name} t WHERE t.school_id=$1 AND t.id=$3 AND ${resourceScope(name, a)} FOR UPDATE`,
            [a.context.schoolId, a.id, id],
          )
        ).rows[0];
        if (!old) throw notFound();
        const merged = { ...old, ...patch };
        await validateBusiness(tx, a, name, merged, true);
        if (!Object.keys(patch).length) return old;
        if (name === 'academic_sessions' && patch.is_current)
          await tx.query(
            'UPDATE academic_sessions SET is_current=false WHERE school_id=$1 AND is_current AND id<>$2',
            [a.context.schoolId, id],
          );
        const keys = Object.keys(patch);
        const updated = (
          await tx.query(
            `UPDATE ${name} SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(',')} WHERE school_id=$1 AND id=$2 RETURNING *`,
            [a.context.schoolId, id, ...keys.map((k) => patch[k])],
          )
        ).rows[0];
        await audit(tx, a.context.schoolId, a.id, `${name}.update`, name, id);
        return updated;
      });
      res.json(row);
    }),
  );
  router.get(
    '/attendance',
    permission('attendance.read'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        q = pageSchema.parse(req.query),
        date = q.date || localParts(new Date(), a.active!.timezone).date;
      const result = await transaction(
        pool,
        a.context,
        async (tx) => {
          const values = [a.context.schoolId, a.id, date, q.class_id || null];
          const where = `t.school_id=$1 AND t.attendance_date=$3 AND ($4::uuid IS NULL OR t.class_id=$4) AND ${studentScope(a, 't.student_id', '$2')}`;
          const total = Number(
            (await tx.query(`SELECT count(*) FROM daily_attendance t WHERE ${where}`, values))
              .rows[0].count,
          );
          const data = (
            await tx.query(
              `SELECT t.*,s.first_name,s.last_name,s.student_code,c.grade,c.section FROM daily_attendance t JOIN students s ON s.school_id=t.school_id AND s.id=t.student_id JOIN classes c ON c.school_id=t.school_id AND c.id=t.class_id WHERE ${where} ORDER BY s.first_name,t.id LIMIT $5 OFFSET $6`,
              [...values, q.page_size, (q.page - 1) * q.page_size],
            )
          ).rows;
          return { data, total, page: q.page, page_size: q.page_size };
        },
        true,
      );
      res.json(result);
    }),
  );
  router.post(
    '/attendance/manual',
    permission('attendance.manual_write'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = manualSchema.parse(req.body);
      const row = await transaction(pool, a.context, async (tx) => {
        await requireWrite(tx, a);
        await assertStudent(tx, a, b.student_id);
        const en = (
          await tx.query(
            'SELECT * FROM enrollments WHERE school_id=$1 AND student_id=$2 AND starts_on<=$3 AND (ends_on IS NULL OR ends_on>=$3) ORDER BY starts_on DESC LIMIT 1',
            [a.context.schoolId, b.student_id, b.date],
          )
        ).rows[0];
        if (!en) throw new ApiError(422, 'ENROLLMENT_REQUIRED', 'No enrollment for this date.');
        await tx.query(
          'INSERT INTO daily_attendance(school_id,student_id,attendance_date,class_id,academic_session_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(school_id,student_id,attendance_date) DO NOTHING',
          [a.context.schoolId, b.student_id, b.date, en.class_id, en.academic_session_id],
        );
        const day = (
          await tx.query(
            'SELECT * FROM daily_attendance WHERE school_id=$1 AND student_id=$2 AND attendance_date=$3 FOR UPDATE',
            [a.context.schoolId, b.student_id, b.date],
          )
        ).rows[0];
        if (b.expected_version !== undefined && day.version !== b.expected_version)
          throw new ApiError(409, 'VERSION_CONFLICT', 'Attendance changed. Refresh before saving.');
        if (day.source === 'NFC' && day.version > 0)
          throw new ApiError(
            409,
            'CORRECTION_REQUIRED',
            'Request a correction to change NFC attendance.',
          );
        const updated = (
          await tx.query(
            "UPDATE daily_attendance SET attendance_status=$2,source='MANUAL',manual_override=true,version=version+1 WHERE id=$1 RETURNING *",
            [day.id, b.status],
          )
        ).rows[0];
        await audit(
          tx,
          a.context.schoolId,
          a.id,
          `attendance.manual:${b.reason}`,
          'daily_attendance',
          day.id,
        );
        if (day.attendance_status !== b.status)
          await queue(
            tx,
            a.context.schoolId,
            b.student_id,
            'ATTENDANCE_CORRECTED',
            `ATTENDANCE_CORRECTED:${day.id}:${updated.version}`,
            {
              attendance_status: b.status,
              attendance_date: b.date,
              event_time: new Date().toISOString(),
            },
          );
        return updated;
      });
      res.json(row);
    }),
  );
  router.get(
    '/corrections',
    permission('attendance.read'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      res.json(
        await transaction(
          pool,
          a.context,
          (tx) =>
            paged(
              tx,
              `SELECT c.*,t.student_id,t.attendance_date,s.first_name,s.last_name FROM attendance_corrections c JOIN daily_attendance t ON t.school_id=c.school_id AND t.id=c.daily_attendance_id JOIN students s ON s.school_id=t.school_id AND s.id=t.student_id WHERE c.school_id=$1 AND ${studentScope(a, 't.student_id', '$2')} ORDER BY c.requested_at DESC,c.id`,
              [a.context.schoolId, a.id],
              req.query,
            ),
          true,
        ),
      );
    }),
  );
  router.post(
    '/corrections',
    permission('attendance.correct_request'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = correctionSchema.parse(req.body);
      res.status(201).json(
        await transaction(pool, a.context, async (tx) => {
          await requireWrite(tx, a);
          const day = (
            await tx.query(
              `SELECT t.* FROM daily_attendance t WHERE t.school_id=$1 AND t.id=$3 AND ${studentScope(a, 't.student_id', '$2')}`,
              [a.context.schoolId, a.id, b.daily_attendance_id],
            )
          ).rows[0];
          if (!day) throw notFound();
          return (
            await tx.query(
              'INSERT INTO attendance_corrections(school_id,daily_attendance_id,requested_status,reason,requested_by) VALUES($1,$2,$3,$4,$5) RETURNING *',
              [a.context.schoolId, b.daily_attendance_id, b.requested_status, b.reason, a.id],
            )
          ).rows[0];
        }),
      );
    }),
  );
  router.post(
    '/corrections/:id/decision',
    permission('attendance.correct_approve'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        id = uuid.parse(req.params.id),
        b = z.object({ approve: z.boolean() }).strict().parse(req.body);
      res.json(
        await transaction(pool, a.context, async (tx) => {
          await requireWrite(tx, a);
          const c = (
            await tx.query(
              "SELECT * FROM attendance_corrections WHERE school_id=$1 AND id=$2 AND status='REQUESTED' FOR UPDATE",
              [a.context.schoolId, id],
            )
          ).rows[0];
          if (!c) throw notFound();
          if (c.requested_by === a.id)
            throw new ApiError(
              403,
              'SELF_APPROVAL_FORBIDDEN',
              'Another authorized reviewer must decide this request.',
            );
          const day = (
            await tx.query(
              'SELECT * FROM daily_attendance WHERE school_id=$1 AND id=$2 FOR UPDATE',
              [a.context.schoolId, c.daily_attendance_id],
            )
          ).rows[0];
          if (b.approve) {
            await tx.query(
              "UPDATE daily_attendance SET attendance_status=$2,source='MANUAL',manual_override=true,version=version+1 WHERE id=$1",
              [day.id, c.requested_status],
            );
            if (day.attendance_status !== c.requested_status)
              await queue(
                tx,
                a.context.schoolId,
                day.student_id,
                'ATTENDANCE_CORRECTED',
                `ATTENDANCE_CORRECTED:${day.id}:${day.version + 1}`,
                {
                  attendance_status: c.requested_status,
                  attendance_date: day.attendance_date,
                  event_time: new Date().toISOString(),
                },
              );
          }
          return (
            await tx.query(
              "UPDATE attendance_corrections SET status=$2,approved_by=$3,decided_at=now(),applied_at=CASE WHEN $2='APPLIED' THEN now() ELSE NULL END WHERE id=$1 RETURNING *",
              [id, b.approve ? 'APPLIED' : 'REJECTED', a.id],
            )
          ).rows[0];
        }),
      );
    }),
  );
  router.post(
    '/fees/:id/remind',
    permission('fees.write'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        id = uuid.parse(req.params.id);
      res.json(
        await transaction(pool, a.context, async (tx) => {
          await requireWrite(tx, a);
          const fee = (
            await tx.query('SELECT * FROM fee_records WHERE school_id=$1 AND id=$2', [
              a.context.schoolId,
              id,
            ])
          ).rows[0];
          if (!fee) throw notFound();
          if (['PAID', 'WAIVED'].includes(fee.status))
            throw new ApiError(409, 'FEE_SETTLED', 'This fee has no outstanding balance.');
          const date = localParts(new Date(), a.active!.timezone).date;
          const queued = await queue(
            tx,
            a.context.schoolId,
            fee.student_id,
            'FEE_REMINDER',
            `FEE_REMINDER:${id}:${date}`,
            {
              fee_type: fee.fee_type,
              amount_due: fee.amount_due,
              amount_paid: fee.amount_paid,
              currency: fee.currency,
              due_on: fee.due_on,
              event_time: new Date().toISOString(),
            },
          );
          return { queued };
        }),
      );
    }),
  );
  router.get(
    '/subscription',
    permission('subscription.read'),
    asyncRoute(async (_req, res) => {
      const a = res.locals.actor;
      res.json(await loadEntitlements(pool, a));
    }),
  );
  router.get(
    '/audit',
    permission('audit.read'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      res.json(
        await transaction(
          pool,
          a.context,
          (tx) =>
            req.query.cursor === '1'
              ? cursorPage(
                  tx,
                  'SELECT id,occurred_at,actor_type,action,entity_type,entity_id FROM audit_logs',
                  'WHERE school_id=$1',
                  [a.context.schoolId],
                  'occurred_at',
                  'id',
                  'bigint',
                  req.query,
                )
              : paged(
                  tx,
                  'SELECT id,occurred_at,actor_type,action,entity_type,entity_id FROM audit_logs WHERE school_id=$1 ORDER BY occurred_at DESC,id DESC',
                  [a.context.schoolId],
                  req.query,
                ),
          true,
        ),
      );
    }),
  );
  router.post(
    '/invitations',
    permission('users.manage'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = inviteSchema.parse(req.body);
      await transaction(pool, a.context, (tx) => requireWrite(tx, a));
      res
        .status(201)
        .json(
          await inviteMember(
            pool,
            a.context,
            storage,
            { school_id: a.context.schoolId, ...b },
            config.WEB_ORIGINS.split(',')[0].trim() + '/auth/callback',
          ),
        );
    }),
  );
  router.get(
    '/invitations',
    permission('users.manage'),
    asyncRoute(async (req, res) => {
      res.json(
        await transaction(
          pool,
          res.locals.actor.context,
          (tx) =>
            paged(
              tx,
              'SELECT id,email,full_name,role_code,status,expires_at FROM school_invitations WHERE school_id=$1 ORDER BY created_at DESC,id',
              [res.locals.actor.context.schoolId],
              req.query,
            ),
          true,
        ),
      );
    }),
  );
  router.post(
    '/invitations/:id/resend',
    permission('users.manage'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        id = uuid.parse(req.params.id);
      const item = await transaction(pool, a.context, async (tx) => {
        await requireWrite(tx, a);
        return (
          await tx.query(
            'SELECT email,full_name,role_code FROM school_invitations WHERE id=$1 AND school_id=$2',
            [id, a.context.schoolId],
          )
        ).rows[0];
      });
      if (!item) throw notFound();
      res.json(
        await inviteMember(
          pool,
          a.context,
          storage,
          {
            school_id: a.context.schoolId,
            email: item.email,
            full_name: item.full_name,
            role: item.role_code,
          },
          config.WEB_ORIGINS.split(',')[0].trim() + '/auth/callback',
          true,
        ),
      );
    }),
  );
  router.post(
    '/invitations/:id/cancel',
    permission('users.manage'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        id = uuid.parse(req.params.id);
      try {
        await transaction(pool, a.context, async (tx) => {
          await requireWrite(tx, a);
          await tx.query('SELECT app.cancel_school_invitation($1)', [id]);
        });
      } catch (error) {
        invitationError(error);
      }
      res.status(204).end();
    }),
  );
  router.get(
    '/memberships',
    permission('users.manage'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      res.json(
        await transaction(
          pool,
          a.context,
          (tx) =>
            paged(
              tx,
              'SELECT m.id,m.user_id,u.full_name,u.email,r.code AS role,m.status FROM school_memberships m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id WHERE m.school_id=$1 ORDER BY u.full_name,m.id',
              [a.context.schoolId],
              req.query,
            ),
          true,
        ),
      );
    }),
  );
  router.patch(
    '/memberships/:id',
    permission('users.manage'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        id = uuid.parse(req.params.id),
        b = z
          .object({
            role: z.enum(['school_admin', 'principal', 'teacher', 'parent', 'student']),
            status: z.enum(['ACTIVE', 'SUSPENDED', 'REMOVED']),
          })
          .strict()
          .parse(req.body);
      res.json(
        await transaction(pool, a.context, async (tx) => {
          await requireWrite(tx, a);
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            a.context.schoolId + ':memberships',
          ]);
          const old = (
            await tx.query(
              'SELECT * FROM school_memberships WHERE school_id=$1 AND id=$2 FOR UPDATE',
              [a.context.schoolId, id],
            )
          ).rows[0];
          if (!old) throw notFound();
          if (old.status === 'INVITED')
            throw new ApiError(
              409,
              'INVITATION_PENDING',
              'The invited person must accept their invitation before access becomes active.',
            );
          if (old.user_id === a.id)
            throw new ApiError(
              409,
              'SELF_CHANGE_FORBIDDEN',
              'Another school administrator must change your membership.',
            );
          return (
            await tx.query(
              'UPDATE school_memberships SET role_id=(SELECT id FROM roles WHERE code=$3),status=$4 WHERE school_id=$1 AND id=$2 RETURNING id,status',
              [a.context.schoolId, id, b.role, b.status],
            )
          ).rows[0];
        }),
      );
    }),
  );
  router.post(
    '/reports',
    permission('reports.export'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = reportSchema.parse(req.body);
      const needed =
        b.kind === 'FEES' ? 'fees.read' : b.kind === 'ACADEMIC' ? 'marks.read' : 'attendance.read';
      if (!a.active!.permissions.includes(needed))
        throw new ApiError(403, 'FORBIDDEN', 'You cannot export this report.');
      res.status(202).json(
        await transaction(pool, a.context, async (tx) => {
          if (b.student_id) await assertStudent(tx, a, b.student_id);
          if (b.class_id) await assertClass(tx, a, b.class_id);
          if (['parent', 'student'].includes(a.active!.role) && !b.student_id)
            throw new ApiError(422, 'STUDENT_REQUIRED', 'Select a linked student.');
          return (
            await tx.query(
              'INSERT INTO report_documents(school_id,kind,student_id,class_id,parameters,requested_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
              [
                a.context.schoolId,
                b.kind,
                b.student_id || null,
                b.class_id || null,
                { ...b, role: a.active!.role },
                a.id,
              ],
            )
          ).rows[0];
        }),
      );
    }),
  );
  router.get(
    '/reports',
    permission('reports.export'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      res.json(
        await transaction(
          pool,
          a.context,
          (tx) =>
            paged(
              tx,
              'SELECT id,kind,status,student_id,class_id,created_at,error_code FROM report_documents WHERE school_id=$1 AND requested_by=$2 ORDER BY created_at DESC,id',
              [a.context.schoolId, a.id],
              req.query,
            ),
          true,
        ),
      );
    }),
  );
  router.get(
    '/reports/:id/download',
    permission('reports.export'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        id = uuid.parse(req.params.id);
      const report = await transaction(
        pool,
        a.context,
        async (tx) => {
          const r = (
            await tx.query(
              "SELECT * FROM report_documents WHERE school_id=$1 AND id=$2 AND requested_by=$3 AND status='COMPLETED'",
              [a.context.schoolId, id, a.id],
            )
          ).rows[0];
          if (!r) throw notFound();
          if (r.student_id) await assertStudent(tx, a, r.student_id);
          if (r.class_id) await assertClass(tx, a, r.class_id);
          return r;
        },
        true,
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json(
        signedDownload(
          config.TOKEN_ENCRYPTION_KEY,
          `/reports/${id}/file`,
          a.id,
          a.context.schoolId,
        ),
      );
    }),
  );
  router.get(
    '/reports/:id/file',
    permission('reports.export'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        id = uuid.parse(req.params.id);
      verifyDownload(
        config.TOKEN_ENCRYPTION_KEY,
        `/reports/${id}/file`,
        a.id,
        a.context.schoolId,
        req.query.expires,
        req.query.signature,
      );
      const report = await transaction(pool, a.context, async (tx) => {
        const r = (
          await tx.query(
            "SELECT * FROM report_documents WHERE school_id=$1 AND id=$2 AND requested_by=$3 AND status='COMPLETED'",
            [a.context.schoolId, id, a.id],
          )
        ).rows[0];
        if (!r) throw notFound();
        if (r.student_id) await assertStudent(tx, a, r.student_id);
        if (r.class_id) await assertClass(tx, a, r.class_id);
        const needed =
          r.kind === 'FEES'
            ? 'fees.read'
            : r.kind === 'ACADEMIC'
              ? 'marks.read'
              : 'attendance.read';
        if (!a.active!.permissions.includes(needed)) throw notFound();
        await audit(tx, a.context.schoolId, a.id, 'report.download', 'report_documents', id);
        return r;
      });
      const object = await storage.storage.from('school-documents').download(report.storage_path);
      if (object.error)
        throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Report storage is unavailable.');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="vidyalayaa-${report.kind.toLowerCase()}.pdf"`,
      );
      res.send(Buffer.from(await object.data.arrayBuffer()));
    }),
  );
  router.post(
    '/materials/upload',
    permission('assignments.write'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = z
          .object({
            class_id: uuid,
            filename: z.string().regex(/^[a-zA-Z0-9._-]{1,100}\.(pdf|png|jpg|jpeg)$/),
          })
          .strict()
          .parse(req.body);
      await transaction(pool, a.context, async (tx) => {
        await requireWrite(tx, a, 'assignments');
        await assertClass(tx, a, b.class_id);
      });
      const path = `${a.context.schoolId}/materials/${b.class_id}/${crypto.randomUUID()}-${b.filename}`;
      const signed = await storage.storage.from('school-documents').createSignedUploadUrl(path);
      if (signed.error)
        throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Upload storage is unavailable.');
      res.json({ path, url: signed.data.signedUrl, token: signed.data.token });
    }),
  );
  router.get(
    '/materials/:id/download',
    permission('assignments.read'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        id = uuid.parse(req.params.id),
        r = await transaction(
          pool,
          a.context,
          async (tx) =>
            (
              await tx.query(
                `SELECT t.* FROM assignments t WHERE t.school_id=$1 AND t.id=$3 AND ${resourceScope('assignments', a)}`,
                [a.context.schoolId, a.id, id],
              )
            ).rows[0],
          true,
        );
      if (!r?.storage_path) throw notFound();
      const signed = await storage.storage
        .from('school-documents')
        .createSignedUrl(r.storage_path, 60);
      if (signed.error)
        throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Material storage is unavailable.');
      res.json({ url: signed.data.signedUrl });
    }),
  );
  router.get(
    '/notifications',
    permission('notifications.read'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      res.json(
        await transaction(
          pool,
          a.context,
          (tx) => {
            const select =
                'SELECT d.id,d.channel,d.status,d.created_at,d.sent_at,d.last_error,t.kind,t.payload FROM notification_deliveries d JOIN notification_outbox t ON t.school_id=d.school_id AND t.id=d.outbox_id',
              where = `WHERE d.school_id=$1 ${a.active!.role === 'parent' ? `AND EXISTS(SELECT 1 FROM parents p WHERE p.school_id=d.school_id AND p.id=d.parent_id AND p.user_id=$2 AND p.status='ACTIVE') AND (t.student_id IS NULL OR ${studentScope(a, 't.student_id', '$2')}) AND (t.payload->>'class_id' IS NULL OR ${classScope(a, "(t.payload->>'class_id')::uuid", '$2')})` : 'AND $2::uuid IS NOT NULL'}`;
            return req.query.cursor === '1'
              ? cursorPage(
                  tx,
                  select,
                  where,
                  [a.context.schoolId, a.id],
                  'd.created_at',
                  'd.id',
                  'uuid',
                  req.query,
                )
              : paged(
                  tx,
                  `${select} ${where} ORDER BY d.created_at DESC,d.id DESC`,
                  [a.context.schoolId, a.id],
                  req.query,
                );
          },
          true,
        ),
      );
    }),
  );
  router.post(
    '/push-tokens',
    permission('notifications.preferences'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = z
          .object({
            token: z.string().min(20).max(4096),
            platform: z.enum(['WEB', 'ANDROID', 'IOS']),
          })
          .strict()
          .parse(req.body);
      await transaction(pool, a.context, async (tx) => {
        await tx.query(
          'INSERT INTO push_tokens(school_id,user_id,token_hash,token_encrypted,platform) VALUES($1,$2,$3,$4,$5) ON CONFLICT(token_hash) DO UPDATE SET is_active=true,last_seen_at=now(),token_encrypted=EXCLUDED.token_encrypted WHERE push_tokens.school_id=$1 AND push_tokens.user_id=$2',
          [
            a.context.schoolId,
            a.id,
            hash(b.token),
            encrypt(b.token, config.TOKEN_ENCRYPTION_KEY),
            b.platform,
          ],
        );
      });
      res.status(204).end();
    }),
  );
  router.delete(
    '/push-tokens',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = z
          .object({ token_hash: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict()
          .safeParse(req.body);
      if (b.success)
        await transaction(pool, a.context, (tx) =>
          tx.query(
            'UPDATE push_tokens SET is_active=false WHERE school_id=$1 AND user_id=$2 AND token_hash=$3',
            [a.context.schoolId, a.id, b.data.token_hash],
          ),
        );
      res.status(204).end();
    }),
  );
  return router;
}
