import { Router } from 'express';
import multer from 'multer';
import type pg from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  schoolProfileUpdateSchema,
  schoolProfileDetailsSchema,
  schoolProfileAdminSchema,
  schoolProfileCompletion,
  schoolAssetSchema,
  schoolTimingsUpdateSchema,
  defaultSchoolTimings,
  uuid,
  type SchoolProfile,
  type SchoolProfileAsset,
} from '@vidyalayaa/contracts';
import { lockSchoolStorageWrite, transaction, type Tx } from '../../lib/db.js';
import { ApiError, asyncRoute, notFound } from '../../lib/errors.js';
import type { Actor } from '../../middleware/auth.js';
import { resourceScope } from '../school/resources.js';

type Controls = { requireWrite: (tx: Tx, a: Actor, feature?: string) => Promise<void> };
export function schoolProfileRouter(pool: pg.Pool, storage: SupabaseClient, controls?: Controls) {
  const r = Router({ mergeParams: true }),
    platform = !controls;
  const context = (a: Actor) => (platform ? { ...a.context, schoolId: '' } : a.context);
  const sidFor = (params: Record<string, any>, a: Actor) =>
    platform ? uuid.parse(params.schoolId) : a.context.schoolId;
  async function writable(tx: Tx, a: Actor, sid: string, timings = false) {
    if (
      platform &&
      (
        await tx.query(
          "SELECT id FROM school_offboarding WHERE school_id=$1 AND permanent AND status IN ('CLOSED','PURGE_REQUESTED','PURGING')",
          [sid],
        )
      ).rowCount
    )
      throw new ApiError(
        409,
        'SCHOOL_OFFBOARDED',
        'This school profile is frozen for permanent deletion.',
      );
    if (
      !(await tx.query('SELECT app.school_profile_editor($1) AS allowed', [sid])).rows[0]?.allowed
    )
      throw new ApiError(
        403,
        'PROFILE_READONLY',
        'You are not authorized to edit this school profile.',
      );
    if (controls) {
      if (a.active?.role === 'school_admin' && !a.active.permissions.includes('school.manage'))
        throw new ApiError(403, 'FORBIDDEN', 'School management permission is required.');
      if (
        timings &&
        (a.active?.role !== 'school_admin' || !a.active.permissions.includes('timetable.write'))
      )
        throw new ApiError(403, 'FORBIDDEN', 'Only School Admin can change school timings.');
      await controls.requireWrite(tx, a, timings ? 'timetable' : undefined);
    }
  }
  async function school(tx: Tx, sid: string, lock = false) {
    const row = (
      await tx.query(
        `SELECT id,school_code,name,timezone,profile,profile_version,settings->>'locale' AS locale,settings->'timetable' AS timetable FROM schools WHERE id=$1 ${platform ? '' : 'AND app.school_role(id) IS NOT NULL'}${lock ? ' FOR UPDATE' : ''}`,
        [sid],
      )
    ).rows[0];
    if (!row) throw notFound();
    return row;
  }
  async function evidence(tx: Tx, a: Actor, sid: string, action: string, changes: string[]) {
    await tx.query(
      "INSERT INTO audit_logs(school_id,actor_type,actor_id,action,entity_type,entity_id,after) VALUES($1,'USER',$2,$3,'schools',$1,$4)",
      [sid, a.id, action, { changed_fields: changes, scope: 'school_profile' }],
    );
  }
  async function profile(tx: Tx, a: Actor, sid: string): Promise<SchoolProfile> {
    const row = await school(tx, sid),
      role = platform ? 'super_admin' : a.active!.role,
      privileged = platform || ['school_admin', 'principal'].includes(role),
      privateRow = privileged
        ? (
            await tx.query(
              'SELECT details,principal_edit_authorized FROM school_profile_private WHERE school_id=$1',
              [sid],
            )
          ).rows[0]
        : undefined,
      administration = privileged
        ? schoolProfileAdminSchema.parse(privateRow?.details || {})
        : undefined,
      can_edit =
        !!(await tx.query('SELECT app.school_profile_editor($1) AS allowed', [sid])).rows[0]
          ?.allowed &&
        (platform || role === 'principal' || !!a.active?.permissions.includes('school.manage')),
      details = schoolProfileDetailsSchema.parse(row.profile),
      assets = (
        await tx.query<SchoolProfileAsset>(
          'SELECT id,kind,title,content_type,size,created_at FROM school_profile_assets WHERE school_id=$1 AND retired_at IS NULL ORDER BY created_at,id',
          [sid],
        )
      ).rows,
      timings = row.timetable
        ? {
            configured: true,
            version: row.timetable.version,
            settings: (({ version: _, ...rest }) => rest)(row.timetable),
          }
        : { configured: false, version: 0, settings: defaultSchoolTimings };
    const announcements =
      !platform && a.active?.permissions.includes('announcements.read')
        ? (
            await tx.query(
              `SELECT t.id,t.title,t.body,t.published_at FROM announcements t WHERE t.school_id=$1 AND t.published_at<=now() AND ${resourceScope('announcements', a)} ORDER BY t.published_at DESC,t.id LIMIT 5`,
              [sid, a.id],
            )
          ).rows
        : [];
    return {
      school_id: sid,
      school_code: row.school_code,
      name: row.name,
      timezone: row.timezone,
      locale: row.locale === 'hi-IN' ? 'hi-IN' : 'en-IN',
      version: row.profile_version,
      details,
      assets,
      timings,
      ...(privileged
        ? {
            administration,
            principal_edit_authorized: privateRow?.principal_edit_authorized || false,
          }
        : {}),
      can_edit,
      can_delegate: can_edit && (platform || role === 'school_admin'),
      can_manage_timings:
        can_edit &&
        (platform ||
          (role === 'school_admin' &&
            !!a.features.timetable &&
            !!a.active?.permissions.includes('timetable.write'))),
      completion: privileged
        ? schoolProfileCompletion({ name: row.name, details, administration, assets, timings })
        : null,
      announcements,
    };
  }
  r.get(
    '/',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        sid = sidFor(req.params, a);
      res.json(await transaction(pool, context(a), (tx) => profile(tx, a, sid), true));
    }),
  );
  r.put(
    '/',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        sid = sidFor(req.params, a),
        b = schoolProfileUpdateSchema.parse(req.body);
      res.json(
        await transaction(pool, context(a), async (tx) => {
          await writable(tx, a, sid);
          const old = await school(tx, sid, true);
          if (old.profile_version !== b.expected_version)
            throw new ApiError(
              409,
              'PROFILE_VERSION_CONFLICT',
              'The school profile changed. Refresh it before saving your changes.',
            );
          if (
            b.principal_edit_authorized !== undefined &&
            !platform &&
            a.active?.role !== 'school_admin'
          )
            throw new ApiError(
              403,
              'FORBIDDEN',
              'Only an administrator can authorize Principal profile editing.',
            );
          if (b.administration || b.principal_edit_authorized !== undefined) {
            const current = (
              await tx.query(
                'SELECT details,principal_edit_authorized FROM school_profile_private WHERE school_id=$1',
                [sid],
              )
            ).rows[0];
            await tx.query(
              current
                ? 'UPDATE school_profile_private SET details=$2,principal_edit_authorized=$3 WHERE school_id=$1'
                : 'INSERT INTO school_profile_private(school_id,details,principal_edit_authorized) VALUES($1,$2,$3)',
              [
                sid,
                b.administration || current?.details || {},
                b.principal_edit_authorized ?? current?.principal_edit_authorized ?? false,
              ],
            );
          }
          await tx.query(
            "UPDATE schools SET name=$2,timezone=$3,profile=$4,profile_version=profile_version+1,settings=jsonb_set(settings,'{locale}',to_jsonb($5::text),true) WHERE id=$1",
            [sid, b.name, b.timezone, b.details, b.locale],
          );
          await evidence(tx, a, sid, 'school_profile.updated', [
            'name',
            'timezone',
            'locale',
            'profile',
            ...(b.administration ? ['administration'] : []),
            ...(b.principal_edit_authorized !== undefined ? ['principal_edit_authorized'] : []),
          ]);
          return profile(tx, a, sid);
        }),
      );
    }),
  );
  r.put(
    '/timings',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        sid = sidFor(req.params, a),
        b = schoolTimingsUpdateSchema.parse(req.body);
      res.json(
        await transaction(pool, context(a), async (tx) => {
          await writable(tx, a, sid, true);
          const old = await school(tx, sid, true);
          if ((old.timetable?.version || 0) !== b.expected_version)
            throw new ApiError(
              409,
              'TIMETABLE_VERSION_CONFLICT',
              'School timings changed. Refresh before saving.',
            );
          const settings = { ...b.settings, version: b.expected_version + 1 };
          await tx.query(
            "UPDATE schools SET settings=jsonb_set(settings,'{timetable}',$2::jsonb,true) WHERE id=$1",
            [sid, settings],
          );
          await evidence(tx, a, sid, 'school_profile.timings.updated', ['timetable']);
          return { configured: true, version: settings.version, settings: b.settings };
        }),
      );
    }),
  );
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 2, fieldSize: 1000 },
  });
  r.post(
    '/assets',
    asyncRoute(async (req, res, next) => {
      const a = res.locals.actor,
        sid = sidFor(req.params, a);
      await transaction(pool, context(a), (tx) => writable(tx, a, sid));
      next();
    }),
    upload.single('file'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        sid = sidFor(req.params, a),
        b = schoolAssetSchema.parse(req.body),
        file = req.file;
      if (!file) throw new ApiError(422, 'FILE_REQUIRED', 'Choose a logo, image or policy PDF.');
      const bytes = file.buffer;
      const type = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? 'image/png'
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          ? 'image/jpeg'
          : bytes.subarray(0, 4).toString() === 'RIFF' &&
              bytes.subarray(8, 12).toString() === 'WEBP'
            ? 'image/webp'
            : bytes.subarray(0, 5).toString() === '%PDF-'
              ? 'application/pdf'
              : null;
      if (
        !type ||
        file.mimetype !== type ||
        (b.kind === 'POLICY') !== (type === 'application/pdf') ||
        (type !== 'application/pdf' && file.size > 5 * 1024 * 1024)
      )
        throw new ApiError(
          422,
          'INVALID_PROFILE_FILE',
          'Use a PNG, JPEG or WebP image up to 5 MB, or a policy PDF up to 10 MB.',
        );
      const id = crypto.randomUUID(),
        ext =
          type === 'image/png'
            ? 'png'
            : type === 'image/jpeg'
              ? 'jpg'
              : type === 'image/webp'
                ? 'webp'
                : 'pdf',
        path = `${sid}/profile/${id}.${ext}`;
      try {
        const result = await transaction(pool, context(a), async (tx) => {
          await lockSchoolStorageWrite(tx, sid);
          await writable(tx, a, sid);
          await school(tx, sid, true);
          const count = (
            await tx.query(
              'SELECT count(*)::int AS n FROM school_profile_assets WHERE school_id=$1 AND kind=$2 AND retired_at IS NULL',
              [sid, b.kind],
            )
          ).rows[0].n;
          if (b.kind !== 'LOGO' && count >= (b.kind === 'IMAGE' ? 12 : 20))
            throw new ApiError(
              409,
              'PROFILE_ASSET_LIMIT',
              'Remove an existing file before adding another.',
            );
          if (b.kind === 'LOGO')
            await tx.query(
              "UPDATE school_profile_assets SET retired_at=now() WHERE school_id=$1 AND kind='LOGO' AND retired_at IS NULL",
              [sid],
            );
          const uploaded = await storage.storage
            .from('school-documents')
            .upload(path, bytes, { contentType: type, upsert: false });
          if (uploaded.error)
            throw new ApiError(
              503,
              'STORAGE_UNAVAILABLE',
              'The file could not be stored. Check the school document storage configuration.',
            );
          const asset = (
            await tx.query(
              'INSERT INTO school_profile_assets(id,school_id,kind,title,storage_path,content_type,size,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,kind,title,content_type,size,created_at',
              [id, sid, b.kind, b.title, path, type, file.size, a.id],
            )
          ).rows[0];
          await tx.query('UPDATE schools SET profile_version=profile_version+1 WHERE id=$1', [sid]);
          await evidence(tx, a, sid, 'school_profile.asset.added', [b.kind]);
          return asset;
        });
        res.status(201).json(result);
      } catch (e) {
        await storage.storage
          .from('school-documents')
          .remove([path])
          .catch(() => undefined);
        throw e;
      }
    }),
  );
  r.delete(
    '/assets/:id',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        sid = sidFor(req.params, a),
        id = uuid.parse(req.params.id);
      await transaction(pool, context(a), async (tx) => {
        await writable(tx, a, sid);
        await school(tx, sid, true);
        const changed = await tx.query(
          'UPDATE school_profile_assets SET retired_at=now() WHERE school_id=$1 AND id=$2 AND retired_at IS NULL RETURNING id',
          [sid, id],
        );
        if (!changed.rowCount) throw notFound();
        await tx.query('UPDATE schools SET profile_version=profile_version+1 WHERE id=$1', [sid]);
        await evidence(tx, a, sid, 'school_profile.asset.removed', [id]);
      });
      res.status(204).end();
    }),
  );
  r.get(
    '/assets/:id',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        sid = sidFor(req.params, a),
        id = uuid.parse(req.params.id),
        asset = await transaction(
          pool,
          context(a),
          async (tx) => {
            await school(tx, sid);
            const row = (
              await tx.query(
                'SELECT storage_path,content_type FROM school_profile_assets WHERE school_id=$1 AND id=$2 AND retired_at IS NULL',
                [sid, id],
              )
            ).rows[0];
            if (!row) throw notFound();
            return row;
          },
          true,
        );
      const object = await storage.storage.from('school-documents').download(asset.storage_path);
      if (object.error || !object.data)
        throw new ApiError(
          503,
          'STORAGE_UNAVAILABLE',
          'The school file is temporarily unavailable.',
        );
      res.setHeader('Content-Type', asset.content_type);
      res.setHeader(
        'Content-Disposition',
        `${asset.content_type === 'application/pdf' ? 'attachment' : 'inline'}; filename="${id}.${asset.content_type === 'application/pdf' ? 'pdf' : 'image'}"`,
      );
      res.send(Buffer.from(await object.data.arrayBuffer()));
    }),
  );
  return r;
}
