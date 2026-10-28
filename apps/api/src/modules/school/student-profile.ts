import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { StudentProfile } from '@vidyalayaa/contracts';
import { transaction } from '../../lib/db.js';
import { asyncRoute, ApiError, notFound } from '../../lib/errors.js';
import type { Actor } from '../../middleware/auth.js';

export function studentProfileRouter(pool: pg.Pool) {
  const r = Router();
  r.use((_req, res, next) => {
    const a: Actor = res.locals.actor;
    if (a.active?.role !== 'student' || !a.active.permissions.includes('students.read'))
      return next(new ApiError(403, 'FORBIDDEN', 'Student profile access required.'));
    next();
  });
  r.get(
    '/profile',
    asyncRoute(async (req, res) => {
      // No IDs, filters or identity overrides are accepted for this endpoint.
      z.object({}).strict().parse(req.query);
      const a: Actor = res.locals.actor;
      const data = await transaction(
        pool,
        a.context,
        async (tx) => {
          const own = (
            await tx.query(
              `SELECT s.id,s.student_code,s.first_name,s.last_name,s.date_of_birth::text,s.gender,s.email,s.status,u.phone
         FROM students s JOIN users u ON u.id=s.user_id WHERE s.school_id=$1 AND s.user_id=$2`,
              [a.context.schoolId, a.id],
            )
          ).rows[0];
          if (!own) throw notFound();
          const school = (
            await tx.query('SELECT name,school_code FROM schools WHERE id=$1', [a.context.schoolId])
          ).rows[0];
          if (!school) throw notFound();
          const enrollments = (
            await tx.query(
              `SELECT c.grade,c.section,e.roll_number,ac.name AS session_name,ac.starts_on::text AS session_starts_on,
         ac.ends_on::text AS session_ends_on,e.starts_on::text,e.ends_on::text,e.status,
         (e.status='ACTIVE' AND c.retired_at IS NULL AND ac.retired_at IS NULL
          AND (now() AT TIME ZONE sc.timezone)::date BETWEEN ac.starts_on AND ac.ends_on
          AND e.starts_on<=(now() AT TIME ZONE sc.timezone)::date
          AND (e.ends_on IS NULL OR e.ends_on>=(now() AT TIME ZONE sc.timezone)::date)) AS is_current
         FROM enrollments e JOIN classes c ON c.school_id=e.school_id AND c.id=e.class_id
         JOIN academic_sessions ac ON ac.school_id=e.school_id AND ac.id=e.academic_session_id
         JOIN schools sc ON sc.id=e.school_id WHERE e.school_id=$1 AND e.student_id=$2
         ORDER BY e.starts_on DESC,e.id`,
              [a.context.schoolId, own.id],
            )
          ).rows;
          const guardians = (
            await tx.query(
              `SELECT p.full_name,p.email,p.phone,sp.relationship,sp.is_primary_contact
         FROM student_parents sp JOIN parents p ON p.school_id=sp.school_id AND p.id=sp.parent_id
         WHERE sp.school_id=$1 AND sp.student_id=$2 AND sp.status='ACTIVE' AND p.status='ACTIVE'
         ORDER BY sp.is_primary_contact DESC,p.full_name,sp.id`,
              [a.context.schoolId, own.id],
            )
          ).rows;
          const { id: _id, ...student } = own;
          return { student, school, enrollments, guardians } as StudentProfile;
        },
        true,
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json(data);
    }),
  );
  r.all('/profile', (_req, _res, next) =>
    next(new ApiError(405, 'METHOD_NOT_ALLOWED', 'Official student profiles are read-only.')),
  );
  return r;
}
