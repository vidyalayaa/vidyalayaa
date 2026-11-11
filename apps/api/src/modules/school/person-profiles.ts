import { createHash, randomUUID } from 'node:crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import type pg from 'pg';
import multer from 'multer';
import { z } from 'zod';
import {
  DEFAULT_PROFILE_PHOTO_BYTES,
  MAX_PROFILE_ARCHIVE_BYTES,
  personKind,
  photoAssignmentsSchema,
  staffDetailsSchema,
  staffRoles,
  studentContactSchema,
  uuid,
  type PersonKind,
  type PersonPhoto,
  type PhotoCandidate,
  type PhotoImportResult,
  type PhotoPreview,
} from '@vidyalayaa/contracts';
import { audit, transaction, type Tx } from '../../lib/db.js';
import { ApiError, asyncRoute, notFound } from '../../lib/errors.js';
import { paged } from '../../lib/pagination.js';
import { personPhotoPath as pathFor } from '../../lib/person-photo-path.js';
import type { Actor } from '../../middleware/auth.js';
import { studentScope } from './resources.js';
import { savePersonDetails } from './person-profile-details.js';
import {
  MAX_PROFILE_WORKBOOK_BYTES,
  normalizePhoto,
  normalizedPersonCode,
  photoThumbnail,
  readPhotoArchive,
  workbookCsv,
} from './person-profile-files.js';

const tableFor = (kind: PersonKind) => (kind === 'student' ? 'students' : 'teachers');
const permissionFor = (kind: PersonKind) => `${tableFor(kind)}.write`;
const staffActor = (a: Actor) => staffRoles.some((role) => role === a.active?.role);
const admin = (a: Actor) => a.active?.role === 'school_admin';
const forbidden = () =>
  new ApiError(403, 'FORBIDDEN', 'Profile access is unavailable for this role.');
const photoChanged = () =>
  new ApiError(
    409,
    'PROFILE_PHOTO_CHANGED',
    'This profile photo changed. Review the latest photo before trying again.',
  );
const archiveHash = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

function requireAdmin(a: Actor, kind: PersonKind) {
  if (!admin(a) || !a.active?.permissions.includes(permissionFor(kind))) throw forbidden();
}

function profileScope(a: Actor, kind: PersonKind, photo = false) {
  if (kind === 'student') {
    if (!a.active?.permissions.includes('students.read')) throw forbidden();
    return studentScope(a, 't.id', '$3');
  }
  if (!staffActor(a)) throw forbidden();
  if (
    admin(a) ||
    (photo && a.active?.role === 'principal' && a.active.permissions.includes('teachers.read'))
  )
    return '$3::uuid IS NOT NULL';
  return 't.user_id=$3';
}

async function photoRef(tx: Tx, a: Actor, kind: PersonKind, id: string) {
  const row = (
    await tx.query<PersonPhoto>(
      `SELECT t.id,t.profile_photo_id AS photo_id FROM ${tableFor(kind)} t
      WHERE t.school_id=$1 AND t.id=$2 AND ${profileScope(a, kind, true)}`,
      [a.context.schoolId, id, a.id],
    )
  ).rows[0];
  if (!row) throw notFound();
  return row;
}

const photoFields = z
  .object({
    expected_photo_id: z.preprocess((v) => (v === '' ? null : v), uuid.nullable()),
    replace: z.enum(['true', 'false']).transform((v) => v === 'true'),
  })
  .strict();
type RequireWrite = (tx: Tx, a: Actor) => Promise<void>;

export function personProfilesRouter(
  pool: pg.Pool,
  storage: SupabaseClient,
  requireWrite: RequireWrite,
  photoLimit = DEFAULT_PROFILE_PHOTO_BYTES,
) {
  const r = Router();
  const bucket = () => storage.storage.from('school-documents');
  const authorizeEdit: RequestHandler = (req, res, next) => {
    requireAdmin(res.locals.actor, personKind.parse(req.params.kind));
    next();
  };
  const upload = (fileSize: number, field: string) =>
    multer({
      storage: multer.memoryStorage(),
      limits: { fileSize, files: 1, fields: 3, fieldSize: 100_000, parts: 5 },
    }).single(field);
  const singlePhoto = upload(photoLimit, 'image');
  const zipUpload = upload(MAX_PROFILE_ARCHIVE_BYTES, 'archive');
  const xlsxUpload = upload(MAX_PROFILE_WORKBOOK_BYTES, 'workbook');
  let uploadsInFlight = 0;
  function withUpload(parser: RequestHandler, run: (req: Request, res: Response) => Promise<void>) {
    return asyncRoute(async (req, res) => {
      if (uploadsInFlight >= 3)
        throw new ApiError(
          429,
          'PROFILE_UPLOAD_BUSY',
          'Other profile uploads are processing. Try again shortly.',
        );
      uploadsInFlight++;
      try {
        await new Promise<void>((resolve, reject) =>
          parser(req, res, (error) => (error ? reject(error) : resolve())),
        );
        await run(req, res);
      } finally {
        uploadsInFlight--;
      }
    });
  }

  async function removeObject(path: string) {
    await bucket()
      .remove([path])
      .catch(() => undefined);
  }

  async function changePhoto(
    a: Actor,
    kind: PersonKind,
    id: string,
    expected: string | null,
    bytes?: Buffer,
  ) {
    const school = a.context.schoolId;
    const revision = bytes ? randomUUID() : null;
    const path = revision ? pathFor(school, kind, id, revision) : null;
    if (bytes && path) {
      await transaction(
        pool,
        a.context,
        async (tx) => {
          await requireWrite(tx, a);
          if ((await photoRef(tx, a, kind, id)).photo_id !== expected) throw photoChanged();
        },
        true,
      );
      const stored = await bucket().upload(path, bytes, {
        contentType: 'image/jpeg',
        upsert: false,
        cacheControl: '0',
      });
      if (stored.error)
        throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'The photo could not be stored. Try again.');
    }
    try {
      await transaction(pool, a.context, async (tx) => {
        await requireWrite(tx, a);
        const updated = await tx.query(
          `UPDATE ${tableFor(kind)} SET profile_photo_id=$3
           WHERE school_id=$1 AND id=$2 AND profile_photo_id IS NOT DISTINCT FROM $4::uuid RETURNING id`,
          [school, id, revision, expected],
        );
        if (!updated.rowCount) throw photoChanged();
        await audit(
          tx,
          school,
          a.id,
          revision ? 'profile.photo_saved' : 'profile.photo_removed',
          tableFor(kind),
          id,
        );
      });
    } catch (error) {
      if (path) {
        // Recheck after errors where the commit result could be ambiguous.
        if (error instanceof ApiError) await removeObject(path);
        else {
          const current = await transaction(
            pool,
            a.context,
            (tx) => photoRef(tx, a, kind, id),
            true,
          ).catch(() => null);
          if (current && current.photo_id !== revision) await removeObject(path);
        }
      }
      throw error;
    }
    if (expected) await removeObject(pathFor(school, kind, id, expected));
    return { id, photo_id: revision };
  }

  function staffProfile(a: Actor, id?: string) {
    const scope = profileScope(a, 'staff');
    return transaction(
      pool,
      a.context,
      async (tx) => {
        const row = (
          await tx.query(
            `SELECT t.id,t.profile_photo_id AS photo_id,t.staff_code,t.full_name,t.email,t.staff_role,t.status,
          coalesce(d.details,'{}'::jsonb) AS details
          FROM teachers t LEFT JOIN school_person_details d ON d.school_id=t.school_id AND d.staff_id=t.id
          WHERE t.school_id=$1 AND ($2::uuid IS NULL OR t.id=$2) AND ${scope}
            AND ($2::uuid IS NOT NULL OR t.user_id=$3)`,
            [a.context.schoolId, id ?? null, a.id],
          )
        ).rows[0];
        if (!row) return null;
        const assignments =
          row.staff_role === 'teacher'
            ? (
                await tx.query(
                  `SELECT c.grade,c.section,s.name AS subject,ac.name AS session_name,c.class_teacher_id IS NOT DISTINCT FROM $2::uuid AS class_teacher
          FROM classes c JOIN academic_sessions ac ON ac.school_id=c.school_id AND ac.id=c.academic_session_id
          JOIN schools sc ON sc.id=c.school_id
          LEFT JOIN teacher_class_assignments ta ON ta.school_id=c.school_id AND ta.class_id=c.id AND ta.teacher_id=$2
           AND ta.retired_at IS NULL AND ta.starts_on<=(now() AT TIME ZONE sc.timezone)::date
           AND (ta.ends_on IS NULL OR ta.ends_on>=(now() AT TIME ZONE sc.timezone)::date)
          LEFT JOIN subjects s ON s.school_id=ta.school_id AND s.id=ta.subject_id
          WHERE c.school_id=$1 AND ac.is_current AND ac.retired_at IS NULL AND c.retired_at IS NULL
            AND (c.class_teacher_id=$2 OR ta.id IS NOT NULL)
          ORDER BY c.grade,c.section,s.name`,
                  [a.context.schoolId, row.id],
                )
              ).rows
            : [];
        return { ...row, assignments };
      },
      true,
    );
  }

  r.get(
    '/staff/me',
    asyncRoute(async (_req, res) => {
      res.json(await staffProfile(res.locals.actor));
    }),
  );
  r.post(
    '/staff/from-membership/:id',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      requireAdmin(a, 'staff');
      if (!a.active?.permissions.includes('users.manage')) throw forbidden();
      const membership = uuid.parse(req.params.id);
      const { employee_id } = z
        .object({ employee_id: z.string().trim().min(1).max(200) })
        .strict()
        .parse(req.body);
      const id = await transaction(pool, a.context, async (tx) => {
        await requireWrite(tx, a);
        const school = a.context.schoolId;
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          school + ':teachers',
        ]);
        const account = (
          await tx.query(
            `SELECT m.user_id,u.full_name,u.email,r.code AS role FROM school_memberships m
         JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id
         WHERE m.school_id=$1 AND m.id=$2 AND m.status='ACTIVE' AND u.status='ACTIVE' AND r.code::text=ANY($3::text[])
         FOR SHARE OF m`,
            [school, membership, staffRoles],
          )
        ).rows[0];
        if (!account) throw notFound();
        const existing = (
          await tx.query(
            `SELECT id,user_id,staff_role,email,staff_code FROM teachers
         WHERE school_id=$1 AND (user_id=$2 OR lower(normalize(btrim(staff_code),NFKC))=lower(normalize(btrim($3),NFKC))
           OR (staff_role=$4 AND email=$5::citext)) FOR UPDATE`,
            [school, account.user_id, employee_id, account.role, account.email],
          )
        ).rows;
        const conflict = () =>
          new ApiError(
            409,
            'PROFILE_LINK_CONFLICT',
            'Review the existing staff record and use its employee ID and official email.',
          );
        let profileId: string;
        if (existing.length) {
          if (existing.length !== 1) throw conflict();
          const row = existing[0];
          if (
            row.staff_role !== account.role ||
            normalizedPersonCode(row.staff_code) !== normalizedPersonCode(employee_id) ||
            (row.user_id && row.user_id !== account.user_id) ||
            (!row.user_id &&
              (!row.email || row.email.toLowerCase() !== account.email.toLowerCase()))
          )
            throw conflict();
          if (row.user_id) return row.id as string;
          await tx.query('UPDATE teachers SET user_id=$3 WHERE school_id=$1 AND id=$2', [
            school,
            row.id,
            account.user_id,
          ]);
          profileId = row.id;
        } else {
          profileId = (
            await tx.query(
              `INSERT INTO teachers(school_id,user_id,staff_code,full_name,email,staff_role)
           VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
              [
                school,
                account.user_id,
                employee_id,
                account.full_name,
                account.email,
                account.role,
              ],
            )
          ).rows[0].id;
        }
        await audit(tx, school, a.id, 'profile.staff_linked', 'teachers', profileId);
        return profileId;
      });
      res.status(201).json({ id });
    }),
  );
  r.get(
    '/me/photo-reference',
    asyncRoute(async (_req, res) => {
      const a = res.locals.actor;
      const kind = a.active?.role === 'student' ? 'student' : 'staff';
      if (kind === 'staff' && !staffActor(a)) throw forbidden();
      const row = await transaction(
        pool,
        a.context,
        async (tx) =>
          (
            await tx.query(
              `SELECT id,profile_photo_id AS photo_id FROM ${tableFor(kind)} WHERE school_id=$1 AND user_id=$2`,
              [a.context.schoolId, a.id],
            )
          ).rows[0],
        true,
      );
      res.json(row ? { kind, ...row } : null);
    }),
  );
  r.get(
    '/:kind/:id/photo/:revision',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      const kind = personKind.parse(req.params.kind);
      const id = uuid.parse(req.params.id);
      const revision = uuid.parse(req.params.revision);
      const ref = await transaction(pool, a.context, (tx) => photoRef(tx, a, kind, id), true);
      if (ref.photo_id !== revision) throw notFound();
      const image = await bucket().download(pathFor(a.context.schoolId, kind, id, revision));
      if (image.error || !image.data)
        throw new ApiError(
          503,
          'STORAGE_UNAVAILABLE',
          'The profile photo is temporarily unavailable.',
        );
      res.setHeader('Cache-Control', 'private, no-store');
      res.type('image/jpeg').send(Buffer.from(await image.data.arrayBuffer()));
    }),
  );
  r.put(
    '/:kind/:id/photo',
    authorizeEdit,
    withUpload(singlePhoto, async (req, res) => {
      const kind = personKind.parse(req.params.kind);
      const id = uuid.parse(req.params.id);
      const fields = photoFields.parse(req.body);
      if (!req.file) throw new ApiError(422, 'PHOTO_REQUIRED', 'Choose an image to upload.');
      if (fields.expected_photo_id && !fields.replace)
        throw new ApiError(
          409,
          'CONFIRM_PHOTO_REPLACEMENT',
          'Confirm replacement of the existing photo.',
        );
      const bytes = await normalizePhoto(req.file.buffer, req.file.originalname);
      res.json(await changePhoto(res.locals.actor, kind, id, fields.expected_photo_id, bytes));
    }),
  );
  r.delete(
    '/:kind/:id/photo',
    authorizeEdit,
    asyncRoute(async (req, res) => {
      const kind = personKind.parse(req.params.kind);
      const id = uuid.parse(req.params.id);
      const body = z.object({ expected_photo_id: uuid }).strict().parse(req.body);
      res.json(await changePhoto(res.locals.actor, kind, id, body.expected_photo_id));
    }),
  );

  r.get('/:kind/photo-limits', authorizeEdit, (_req, res) => {
    res.json({ photo_bytes: photoLimit, archive_bytes: MAX_PROFILE_ARCHIVE_BYTES });
  });
  r.post(
    '/:kind/workbook',
    authorizeEdit,
    withUpload(xlsxUpload, async (req, res) => {
      if (!req.file || !/\.xlsx$/i.test(req.file.originalname))
        throw new ApiError(422, 'WORKBOOK_REQUIRED', 'Choose an Excel .xlsx file.');
      const a = res.locals.actor;
      await transaction(pool, a.context, (tx) => requireWrite(tx, a), true);
      res.json({ csv: await workbookCsv(req.file.buffer) });
    }),
  );

  const codeColumn = (kind: PersonKind) => (kind === 'student' ? 'student_code' : 'staff_code');
  const nameExpression = (kind: PersonKind) =>
    kind === 'student' ? "concat_ws(' ',first_name,last_name)" : 'full_name';
  const candidatesSql = (kind: PersonKind) =>
    `SELECT id,${codeColumn(kind)} AS code,${nameExpression(kind)} AS name,profile_photo_id AS photo_id
     FROM ${tableFor(kind)} WHERE school_id=$1`;
  const missing = async (tx: Tx, kind: PersonKind, school: string) =>
    (
      await tx.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${tableFor(kind)}
      WHERE school_id=$1 AND profile_photo_id IS NULL`,
        [school],
      )
    ).rows[0].count;

  r.get(
    '/:kind/candidates',
    authorizeEdit,
    asyncRoute(async (req, res) => {
      const kind = personKind.parse(req.params.kind);
      const a = res.locals.actor;
      const query = z
        .object({
          search: z.string().trim().max(200).default(''),
          missing: z.enum(['1']).optional(),
        })
        .parse(req.query);
      res.json(
        await transaction(
          pool,
          a.context,
          (tx) =>
            paged(
              tx,
              candidatesSql(kind) +
                ` AND strpos(lower(concat_ws(' ',${codeColumn(kind)},${nameExpression(kind)})),lower($2))>0
       AND (NOT $3::boolean OR profile_photo_id IS NULL) ORDER BY name,id`,
              [a.context.schoolId, query.search, query.missing === '1'],
              req.query,
            ),
          true,
        ),
      );
    }),
  );
  r.post(
    '/:kind/photos/preview',
    authorizeEdit,
    withUpload(zipUpload, async (req, res) => {
      const kind = personKind.parse(req.params.kind);
      const a = res.locals.actor;
      if (!req.file || !/\.zip$/i.test(req.file.originalname))
        throw new ApiError(422, 'ZIP_REQUIRED', 'Choose a ZIP of profile photos.');
      await transaction(pool, a.context, (tx) => requireWrite(tx, a), true);
      const photos = await readPhotoArchive(req.file.buffer, photoLimit);
      const codes = photos.filter((row) => row.bytes).map((row) => row.code);
      const data = await transaction(
        pool,
        a.context,
        async (tx) => ({
          candidates: (
            await tx.query<PhotoCandidate>(
              candidatesSql(kind) +
                ` AND lower(normalize(btrim(${codeColumn(kind)}),NFKC))=ANY($2::text[]) ORDER BY name,id`,
              [a.context.schoolId, codes],
            )
          ).rows,
          missing: await missing(tx, kind, a.context.schoolId),
        }),
        true,
      );
      const response: PhotoPreview = {
        archive_hash: archiveHash(req.file.buffer),
        ...data,
        photos: [],
      };
      for (const { bytes, ...photo } of photos) {
        const matches = data.candidates.filter(
          (candidate) => normalizedPersonCode(candidate.code) === photo.code,
        );
        const duplicate =
          codes.filter((code) => code === photo.code).length > 1 || matches.length > 1;
        response.photos.push({
          ...photo,
          duplicate,
          ...(bytes ? { thumbnail: await photoThumbnail(bytes) } : {}),
          ...(bytes && matches.length === 1 && !duplicate ? { matched: matches[0].id } : {}),
        });
      }
      res.json(response);
    }),
  );
  r.post(
    '/:kind/photos/import',
    authorizeEdit,
    withUpload(zipUpload, async (req, res) => {
      const kind = personKind.parse(req.params.kind);
      const a = res.locals.actor;
      if (!req.file) throw new ApiError(422, 'ZIP_REQUIRED', 'Choose a ZIP of profile photos.');
      const manifest = z.string().max(95_000).parse(req.body.manifest);
      let data: unknown;
      try {
        data = JSON.parse(manifest);
      } catch {
        throw new ApiError(422, 'INVALID_MATCHES', 'Review photo matches again.');
      }
      const { archive_hash, assignments } = photoAssignmentsSchema.parse(data);
      if (archiveHash(req.file.buffer) !== archive_hash)
        throw new ApiError(
          409,
          'ARCHIVE_CHANGED',
          'The ZIP changed. Preview it again before importing.',
        );
      await transaction(pool, a.context, (tx) => requireWrite(tx, a), true);
      const photos = await readPhotoArchive(
        req.file.buffer,
        photoLimit,
        new Set(assignments.map((row) => row.index)),
      );
      const result: PhotoImportResult = { saved: 0, failed: [], missing: 0 };
      for (let offset = 0; offset < assignments.length; offset += 3) {
        const batch = await Promise.all(
          assignments.slice(offset, offset + 3).map(async (match) => {
            try {
              const photo = photos[match.index];
              if (!photo?.bytes)
                throw new ApiError(422, 'INVALID_PHOTO', 'This file is unavailable or invalid.');
              if (match.expected_photo_id && !match.replace)
                throw new ApiError(
                  409,
                  'CONFIRM_PHOTO_REPLACEMENT',
                  'Confirm replacement of the existing photo.',
                );
              await changePhoto(a, kind, match.person_id, match.expected_photo_id, photo.bytes);
              return null;
            } catch (error) {
              return {
                index: match.index,
                message:
                  error instanceof ApiError
                    ? error.message
                    : 'Could not save this photo. Review and retry.',
              };
            }
          }),
        );
        for (const failure of batch) {
          if (failure) result.failed.push(failure);
          else result.saved++;
        }
      }
      result.missing = await transaction(
        pool,
        a.context,
        (tx) => missing(tx, kind, a.context.schoolId),
        true,
      );
      res.json(result);
    }),
  );

  r.get(
    '/staff/:id',
    asyncRoute(async (req, res) => {
      const row = await staffProfile(res.locals.actor, uuid.parse(req.params.id));
      if (!row) throw notFound();
      res.json(row);
    }),
  );
  r.get(
    '/student/:id',
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      const id = uuid.parse(req.params.id);
      const row = await transaction(
        pool,
        a.context,
        async (tx) =>
          (
            await tx.query(
              `SELECT t.id,t.profile_photo_id AS photo_id,coalesce(d.details,'{}'::jsonb) AS details
         FROM students t LEFT JOIN school_person_details d ON d.school_id=t.school_id AND d.student_id=t.id
         WHERE t.school_id=$1 AND t.id=$2 AND ${profileScope(a, 'student')}`,
              [a.context.schoolId, id, a.id],
            )
          ).rows[0],
        true,
      );
      if (!row) throw notFound();
      res.json(row);
    }),
  );
  r.patch(
    '/:kind/:id',
    authorizeEdit,
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      const kind = personKind.parse(req.params.kind);
      const id = uuid.parse(req.params.id);
      const details = (kind === 'staff' ? staffDetailsSchema : studentContactSchema).parse(
        req.body,
      );
      await transaction(pool, a.context, async (tx) => {
        await requireWrite(tx, a);
        await photoRef(tx, a, kind, id);
        await savePersonDetails(tx, a.context.schoolId, kind, id, details);
        await audit(tx, a.context.schoolId, a.id, 'profile.details_saved', tableFor(kind), id);
      });
      res.json({ details });
    }),
  );
  return r;
}
