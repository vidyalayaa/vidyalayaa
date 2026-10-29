import { resourceSchemas, type Resource } from '@vidyalayaa/contracts';
import type { Actor } from '../../middleware/auth.js';
import type { Tx } from '../../lib/db.js';
import { ApiError, notFound } from '../../lib/errors.js';
export interface ResourceDefinition {
  read: string;
  write?: string;
  search: string[];
  feature?: string;
  scope?: 'student' | 'class' | 'teacher' | 'parent' | 'announcement';
  studentColumn?: string;
  classColumn?: string;
  immutable?: boolean;
}
// Resolve only references on records already authorized by resourceScope.
const relations: Partial<Record<Resource, Record<string, string>>> = {
  students: { user_id: 'users' },
  parents: { user_id: 'users' },
  teachers: { user_id: 'users' },
  classes: { academic_session_id: 'academic_sessions', class_teacher_id: 'teachers' },
  enrollments: {
    student_id: 'students',
    class_id: 'classes',
    academic_session_id: 'academic_sessions',
  },
  student_parents: { student_id: 'students', parent_id: 'parents' },
  teacher_class_assignments: {
    teacher_id: 'teachers',
    class_id: 'classes',
    subject_id: 'subjects',
  },
  exams: { class_id: 'classes', subject_id: 'subjects' },
  marks: { student_id: 'students', exam_id: 'exams', subject_id: 'subjects' },
  assignments: { class_id: 'classes', subject_id: 'subjects' },
  timetable_entries: { class_id: 'classes', subject_id: 'subjects', teacher_id: 'teachers' },
  school_holidays: { class_id: 'classes' },
  announcements: { class_id: 'classes' },
  fee_records: { student_id: 'students', academic_session_id: 'academic_sessions' },
  nfc_cards: { student_id: 'students' },
  device_locations: { class_id: 'classes' },
  attendance_rule_versions: { class_id: 'classes' },
  notification_preferences: { parent_id: 'parents' },
};
export function resourceSelect(name: Resource) {
  return [
    't.*',
    ...Object.entries(relations[name] || {}).map(([column, table]) => {
      const text =
        table === 'students'
          ? "concat_ws(' ',r.first_name,r.last_name)||' · '||r.student_code"
          : table === 'classes'
            ? "concat_ws(' ',r.grade,r.section)"
            : ['teachers', 'parents', 'users'].includes(table)
              ? 'r.full_name'
              : 'r.name';
      return `(SELECT ${text} FROM ${table} r WHERE r.id=t.${column}${table === 'users' ? '' : ' AND r.school_id=t.school_id'}) AS ${column.replace(/_id$/, '_label')}`;
    }),
  ].join(',');
}
export const definitions: Record<Resource, ResourceDefinition> = {
  students: {
    read: 'students.read',
    write: 'students.write',
    search: ['student_code', 'first_name', 'last_name'],
    scope: 'student',
    studentColumn: 'id',
  },
  parents: {
    read: 'parents.read',
    write: 'parents.write',
    search: ['full_name', 'email', 'phone'],
  },
  teachers: {
    read: 'teachers.read',
    write: 'teachers.write',
    search: ['staff_code', 'full_name'],
    scope: 'teacher',
  },
  academic_sessions: { read: 'academics.read', write: 'academics.write', search: ['name'] },
  classes: {
    read: 'academics.read',
    write: 'academics.write',
    search: ['grade', 'section'],
    scope: 'class',
    classColumn: 'id',
  },
  subjects: { read: 'academics.read', write: 'academics.write', search: ['code', 'name'] },
  enrollments: {
    read: 'academics.read',
    write: 'students.write',
    search: ['roll_number'],
    scope: 'student',
  },
  student_parents: { read: 'parents.read', write: 'parents.write', search: [] },
  teacher_class_assignments: {
    read: 'teachers.read',
    write: 'teachers.write',
    search: [],
    scope: 'teacher',
  },
  exams: { read: 'marks.read', write: 'assessments.write', search: ['name'], scope: 'class' },
  marks: { read: 'marks.read', write: 'marks.write', search: ['remarks'], scope: 'student' },
  assignments: {
    read: 'assignments.read',
    write: 'assignments.write',
    search: ['title', 'body'],
    scope: 'class',
    feature: 'assignments',
  },
  timetable_entries: {
    read: 'timetable.read',
    write: 'timetable.write',
    search: ['room'],
    scope: 'class',
    feature: 'timetable',
  },
  school_holidays: {
    read: 'academics.read',
    write: 'academics.write',
    search: ['label'],
    scope: 'class',
  },
  announcements: {
    read: 'announcements.read',
    write: 'announcements.write',
    search: ['title', 'body'],
    scope: 'announcement',
  },
  fee_records: {
    read: 'fees.read',
    write: 'fees.write',
    search: ['fee_type', 'status'],
    scope: 'student',
  },
  nfc_cards: {
    read: 'cards.read',
    write: 'cards.manage',
    search: ['status'],
    feature: 'nfc_attendance',
  },
  device_locations: {
    read: 'devices.read',
    write: 'devices.manage',
    search: ['name', 'location_type'],
    feature: 'nfc_attendance',
  },
  attendance_rule_versions: {
    read: 'rules.read',
    write: 'rules.manage',
    search: ['day_type'],
    feature: 'nfc_attendance',
    immutable: true,
  },
  notification_preferences: {
    read: 'notifications.preferences',
    write: 'notifications.preferences',
    search: ['kind', 'channel'],
    scope: 'parent',
  },
};
export function resourceReadable(name: Resource, a: Actor) {
  if (a.active!.role === 'teacher') {
    if (name === 'academic_sessions') return false;
    if (['classes', 'subjects', 'enrollments', 'school_holidays'].includes(name))
      return a.active!.permissions.includes('classrooms.read');
  }
  return a.active!.permissions.includes(definitions[name].read);
}
export function studentScope(a: Actor, column: string, param: string): string {
  const r = a.active!.role;
  if (r === 'parent')
    return `EXISTS(SELECT 1 FROM student_parents sp JOIN parents p ON p.school_id=sp.school_id AND p.id=sp.parent_id WHERE sp.school_id=t.school_id AND sp.student_id=${column} AND sp.status='ACTIVE' AND p.status='ACTIVE' AND p.user_id=${param})`;
  if (r === 'student')
    return `EXISTS(SELECT 1 FROM students own WHERE own.school_id=t.school_id AND own.id=${column} AND own.user_id=${param} AND own.status='ACTIVE')`;
  if (r === 'teacher')
    return `EXISTS(SELECT 1 FROM enrollments en WHERE en.school_id=t.school_id AND en.student_id=${column} AND en.status='ACTIVE' AND en.starts_on<=(now() AT TIME ZONE (SELECT timezone FROM schools WHERE id=t.school_id))::date AND (en.ends_on IS NULL OR en.ends_on>=(now() AT TIME ZONE (SELECT timezone FROM schools WHERE id=t.school_id))::date) AND ${classScope(a, 'en.class_id', param)})`;
  return ['school_admin', 'principal'].includes(a.active!.role)
    ? `${param}::uuid IS NOT NULL`
    : 'FALSE';
}
export function classScope(a: Actor, column: string, param: string, subject?: string): string {
  if (a.active!.role === 'teacher')
    return `EXISTS(SELECT 1 FROM classes cl JOIN academic_sessions ac ON ac.school_id=cl.school_id AND ac.id=cl.academic_session_id JOIN teachers te ON te.school_id=cl.school_id AND te.user_id=${param} WHERE cl.school_id=t.school_id AND cl.id=${column} AND te.status='ACTIVE' AND te.staff_role='teacher' AND ac.is_current AND ac.retired_at IS NULL AND cl.retired_at IS NULL AND (${subject ? 'FALSE' : 'cl.class_teacher_id=te.id'} OR EXISTS(SELECT 1 FROM teacher_class_assignments ta WHERE ta.school_id=cl.school_id AND ta.class_id=cl.id AND ta.teacher_id=te.id AND ta.retired_at IS NULL AND ta.starts_on<=(now() AT TIME ZONE (SELECT timezone FROM schools WHERE id=t.school_id))::date AND (ta.ends_on IS NULL OR ta.ends_on>=(now() AT TIME ZONE (SELECT timezone FROM schools WHERE id=t.school_id))::date)${subject ? ` AND ta.subject_id=${subject}` : ''})))`;
  if (['parent', 'student'].includes(a.active!.role))
    return `EXISTS(SELECT 1 FROM enrollments en WHERE en.school_id=t.school_id AND en.class_id=${column} AND en.status='ACTIVE' AND ${studentScope(a, 'en.student_id', param)})`;
  return ['school_admin', 'principal'].includes(a.active!.role)
    ? `${param}::uuid IS NOT NULL`
    : 'FALSE';
}
export function resourceScope(name: Resource, a: Actor, param = '$2') {
  if (!['school_admin', 'principal', 'teacher', 'parent', 'student'].includes(a.active!.role))
    return 'FALSE';
  const d = definitions[name];
  if (a.active!.role === 'teacher' && name === 'academic_sessions') return 'FALSE';
  let scope = ['school_admin', 'principal', 'teacher', 'parent', 'student'].includes(a.active!.role)
    ? `${param}::uuid IS NOT NULL`
    : 'FALSE';
  if (d.scope === 'student') scope = studentScope(a, `t.${d.studentColumn || 'student_id'}`, param);
  if (d.scope === 'class')
    scope = `(t.${d.classColumn || 'class_id'} IS NULL OR ${classScope(a, `t.${d.classColumn || 'class_id'}`, param, name === 'assignments' ? 't.subject_id' : undefined)})`;
  if (d.scope === 'teacher' && a.active!.role === 'teacher')
    scope =
      name === 'teachers'
        ? `t.user_id=${param}`
        : `EXISTS(SELECT 1 FROM teachers te WHERE te.school_id=t.school_id AND te.id=t.teacher_id AND te.user_id=${param})`;
  if (d.scope === 'parent')
    scope = `EXISTS(SELECT 1 FROM parents p WHERE p.school_id=t.school_id AND p.id=t.parent_id AND p.user_id=${param} AND p.status='ACTIVE')`;
  if (d.scope === 'announcement') {
    const isFamily = ['parent', 'student'].includes(a.active!.role);
    scope = `(t.class_id IS NULL OR ${classScope(a, 't.class_id', param)})${isFamily ? ` AND t.published_at<=now() AND t.audience IN (${a.active!.role === 'parent' ? "'SCHOOL','CLASS','PARENTS'" : "'SCHOOL','CLASS'"})` : ''}`;
  }
  if (
    [
      'academic_sessions',
      'classes',
      'subjects',
      'exams',
      'assignments',
      'timetable_entries',
      'school_holidays',
      'announcements',
      'teacher_class_assignments',
    ].includes(name)
  )
    scope += ' AND t.retired_at IS NULL';
  if (a.active!.role === 'teacher' && name === 'parents')
    scope += ` AND t.status='ACTIVE' AND EXISTS(SELECT 1 FROM student_parents sp WHERE sp.school_id=t.school_id AND sp.parent_id=t.id AND sp.status='ACTIVE' AND ${studentScope(a, 'sp.student_id', param)})`;
  if (a.active!.role === 'teacher' && name === 'student_parents')
    scope += ` AND t.status='ACTIVE' AND ${studentScope(a, 't.student_id', param)} AND EXISTS(SELECT 1 FROM parents p WHERE p.school_id=t.school_id AND p.id=t.parent_id AND p.status='ACTIVE')`;
  if (a.active!.role === 'teacher' && name === 'subjects')
    scope += ` AND app.teacher_subject_access(t.school_id,t.id)`;
  if (a.active!.role === 'teacher' && name === 'exams')
    scope += ' AND app.teacher_exam_access(t.school_id,t.id)';
  if (a.active!.role === 'teacher' && name === 'marks')
    scope += ' AND app.teacher_mark_access(t.school_id,t.exam_id,t.subject_id)';
  if (name === 'marks')
    scope += ` AND EXISTS(SELECT 1 FROM exams ex WHERE ex.school_id=t.school_id AND ex.id=t.exam_id AND ${a.active!.role === 'teacher' ? 'TRUE' : classScope(a, 'ex.class_id', param, 't.subject_id')}${['parent', 'student'].includes(a.active!.role) ? " AND ex.status='PUBLISHED' AND ex.retired_at IS NULL" : ''})`;
  if (name === 'exams' && ['parent', 'student'].includes(a.active!.role))
    scope += " AND t.status='PUBLISHED'";
  return scope;
}
export async function assertStudent(tx: Tx, a: Actor, id: string) {
  const { rows } = await tx.query(
    `SELECT t.id FROM students t WHERE t.school_id=$1 AND t.id=$3 AND ${studentScope(a, 't.id', '$2')}`,
    [a.context.schoolId, a.id, id],
  );
  if (!rows.length) throw notFound();
}
export async function assertClass(tx: Tx, a: Actor, id: string, subject?: string) {
  const { rows } = await tx.query(
    `SELECT t.id FROM classes t WHERE t.school_id=$1 AND t.id=$3 AND ${classScope(a, 't.id', '$2', subject ? '$4' : undefined)}${subject ? ' AND EXISTS(SELECT 1 FROM subjects s WHERE s.school_id=t.school_id AND s.id=$4)' : ''}`,
    [a.context.schoolId, a.id, id, ...(subject ? [subject] : [])],
  );
  if (!rows.length) throw notFound();
}
export async function validateBusiness(
  tx: Tx,
  a: Actor,
  name: Resource,
  values: Record<string, unknown>,
  isUpdate: boolean,
) {
  if (values.student_id) await assertStudent(tx, a, String(values.student_id));
  if (values.class_id)
    await assertClass(
      tx,
      a,
      String(values.class_id),
      values.subject_id ? String(values.subject_id) : undefined,
    );
  if (
    name === 'teacher_class_assignments' &&
    !(
      await tx.query(
        "SELECT id FROM teachers WHERE school_id=$1 AND id=$2 AND staff_role='teacher' AND status='ACTIVE'",
        [a.context.schoolId, values.teacher_id],
      )
    ).rowCount
  )
    throw new ApiError(422, 'ACTIVE_TEACHER_REQUIRED', 'Choose an active teacher staff record.');
  if (name === 'classes') {
    if (
      !values.class_teacher_id ||
      !(
        await tx.query('SELECT app.valid_class_teacher($1,$2,$3) AS allowed', [
          a.context.schoolId,
          values.id || '00000000-0000-4000-8000-000000000000',
          values.class_teacher_id,
        ])
      ).rows[0]?.allowed
    )
      throw new ApiError(
        422,
        'CLASS_TEACHER_REQUIRED',
        'Choose one active teacher as Class Teacher for this class and section.',
      );
  }
  if (
    name === 'assignments' &&
    !isUpdate &&
    values.subject_id &&
    values.class_id &&
    !(
      await tx.query(
        'SELECT 1 FROM teacher_class_assignments WHERE school_id=$1 AND class_id=$2 AND subject_id=$3 AND retired_at IS NULL',
        [a.context.schoolId, values.class_id, values.subject_id],
      )
    ).rowCount
  )
    throw new ApiError(
      422,
      'CLASS_SUBJECT_REQUIRED',
      'Choose a subject configured for the selected class and section.',
    );
  if (a.active!.role === 'teacher' && name === 'assignments' && !values.subject_id)
    throw new ApiError(422, 'SUBJECT_REQUIRED', 'Select one of your assigned subjects.');
  if (name === 'exams') {
    if (values.assessment_kind === 'SUBJECT_TEST' && !values.subject_id)
      throw new ApiError(422, 'SUBJECT_REQUIRED', 'Subject tests require a subject.');
    if (values.assessment_kind !== 'SUBJECT_TEST' && values.subject_id)
      throw new ApiError(
        422,
        'OFFICIAL_EXAM_SUBJECT',
        'Official examinations contain marks across subjects.',
      );
    if (a.active!.role === 'teacher' && values.assessment_kind !== 'SUBJECT_TEST')
      throw new ApiError(
        403,
        'OFFICIAL_EXAM_ADMIN_ONLY',
        'Only School Admin can manage official examinations.',
      );
    if (isUpdate) {
      const previous = (
        await tx.query(
          'SELECT assessment_kind,subject_id,class_id FROM exams WHERE school_id=$1 AND id=$2',
          [a.context.schoolId, values.id],
        )
      ).rows[0];
      if (
        previous &&
        (previous.assessment_kind !== values.assessment_kind ||
          previous.subject_id !== (values.subject_id || null) ||
          previous.class_id !== values.class_id)
      )
        throw new ApiError(
          409,
          'ASSESSMENT_SCOPE_IMMUTABLE',
          'Create another assessment to change its kind, class or subject.',
        );
    }
  }
  if (
    a.active!.role === 'teacher' &&
    name === 'announcements' &&
    (!values.class_id || values.audience !== 'CLASS')
  )
    throw new ApiError(403, 'FORBIDDEN', 'Teachers may publish only to assigned classes.');
  if (name === 'notification_preferences') {
    const p = await tx.query(
      "SELECT id FROM parents WHERE school_id=$1 AND id=$2 AND user_id=$3 AND status='ACTIVE'",
      [a.context.schoolId, values.parent_id, a.id],
    );
    if (!p.rowCount) throw notFound();
  }
  if (values.user_id) {
    const role =
      name === 'parents'
        ? 'parent'
        : name === 'teachers'
          ? String(values.staff_role || 'teacher')
          : 'student';
    const m = await tx.query(
      "SELECT m.id FROM school_memberships m JOIN roles r ON r.id=m.role_id WHERE m.school_id=$1 AND m.user_id=$2 AND m.status='ACTIVE' AND r.code=$3",
      [a.context.schoolId, values.user_id, role],
    );
    if (!m.rowCount)
      throw new ApiError(
        422,
        'MEMBERSHIP_REQUIRED',
        `Invite this account as ${role} before linking it.`,
      );
  }

  if (name === 'marks') {
    const ex = (
      await tx.query('SELECT * FROM exams WHERE school_id=$1 AND id=$2 FOR UPDATE', [
        a.context.schoolId,
        values.exam_id,
      ])
    ).rows[0];
    if (!ex) throw notFound();
    await assertMarkAccess(tx, a, ex, String(values.subject_id));
    if (ex.status !== 'OPEN')
      throw new ApiError(409, 'EXAM_LOCKED', 'Only open exams accept marks.');
    if (Number(values.score) > Number(ex.max_score))
      throw new ApiError(422, 'SCORE_OUT_OF_RANGE', 'The score exceeds the exam maximum.');
    if (
      !(
        await tx.query(
          "SELECT id FROM enrollments WHERE school_id=$1 AND class_id=$2 AND student_id=$3 AND status='ACTIVE'",
          [a.context.schoolId, ex.class_id, values.student_id],
        )
      ).rowCount
    )
      throw new ApiError(
        422,
        'ENROLLMENT_REQUIRED',
        'The student is not enrolled in this exam class.',
      );
  }
  if (name === 'exams' && isUpdate && values.max_score !== undefined) {
    const m = await tx.query(
      'SELECT max(score) AS max FROM marks WHERE school_id=$1 AND exam_id=$2',
      [a.context.schoolId, values.id],
    );
    if (Number(m.rows[0]?.max || 0) > Number(values.max_score))
      throw new ApiError(409, 'EXISTING_MARKS', 'Existing marks exceed this maximum.');
  }
  if (name === 'assignments' && values.storage_path) {
    const path = String(values.storage_path);
    if (
      !path.startsWith(`${a.context.schoolId}/materials/${values.class_id}/`) ||
      path.includes('..')
    )
      throw new ApiError(
        422,
        'INVALID_STORAGE_PATH',
        'Material path must belong to the selected school and class.',
      );
  }
  if (name === 'timetable_entries') {
    if (a.active!.role !== 'school_admin')
      throw new ApiError(403, 'FORBIDDEN', 'Only School Admin can manage timetables.');
    const old = isUpdate
      ? (
          await tx.query(
            'SELECT class_id,subject_id,teacher_id,weekday,starts_at::text,ends_at::text FROM timetable_entries WHERE school_id=$1 AND id=$2',
            [a.context.schoolId, values.id],
          )
        ).rows[0]
      : undefined;
    const normalized = (key: string, value: unknown) =>
      ['starts_at', 'ends_at'].includes(key) && String(value).length === 5
        ? `${value}:00`
        : String(value);
    const unchanged =
      old &&
      ['class_id', 'subject_id', 'teacher_id', 'weekday', 'starts_at', 'ends_at'].every(
        (k) => normalized(k, old[k]) === normalized(k, values[k]),
      );
    if (!unchanged) {
      if (
        !(
          await tx.query('SELECT app.timetable_assignment_valid($1,$2,$3,$4) AS allowed', [
            a.context.schoolId,
            values.class_id,
            values.subject_id,
            values.teacher_id,
          ])
        ).rows[0]?.allowed
      )
        throw new ApiError(
          422,
          'TIMETABLE_ASSIGNMENT_INVALID',
          'Choose an active subject teacher assigned to this class and section.',
        );
      const config = (
        await tx.query(
          "SELECT settings->'timetable' AS config FROM schools WHERE id=$1 FOR SHARE",
          [a.context.schoolId],
        )
      ).rows[0]?.config;
      if (
        config &&
        (!config.days.includes(values.weekday) ||
          !config.periods.some(
            (p: { start_time: string; end_time: string }) =>
              p.start_time === String(values.starts_at).slice(0, 5) &&
              p.end_time === String(values.ends_at).slice(0, 5) &&
              !/[1-9]/.test(String(values.starts_at).slice(6)) &&
              !/[1-9]/.test(String(values.ends_at).slice(6)),
          ))
      )
        throw new ApiError(
          422,
          'TIMETABLE_PERIOD_INVALID',
          'Choose a configured school day and lecture period.',
        );
    }
    const conflict = await tx.query(
      'SELECT id FROM timetable_entries WHERE school_id=$1 AND retired_at IS NULL AND weekday=$2 AND (teacher_id=$3 OR class_id=$4) AND starts_at<$6::time AND ends_at>$5::time AND id<>coalesce($7::uuid,gen_random_uuid()) FOR UPDATE',
      [
        a.context.schoolId,
        values.weekday,
        values.teacher_id,
        values.class_id,
        values.starts_at,
        values.ends_at,
        values.id || null,
      ],
    );
    if (conflict.rowCount)
      throw new ApiError(
        409,
        'TIMETABLE_CONFLICT',
        'The teacher or class is already scheduled during this slot.',
      );
  }
}
export async function assertMarkAccess(
  tx: Tx,
  a: Actor,
  exam: Record<string, any>,
  subject: string,
) {
  if (a.active!.role === 'teacher') {
    if (
      !(
        await tx.query('SELECT app.teacher_mark_access($1,$2,$3) AS allowed', [
          a.context.schoolId,
          exam.id,
          subject,
        ])
      ).rows[0]?.allowed
    )
      throw new ApiError(
        403,
        'ASSESSMENT_ACCESS_DENIED',
        'Official results require the designated Class Teacher; subject tests require an exact class and subject assignment.',
      );
  } else await assertClass(tx, a, exam.class_id);
  if (exam.assessment_kind === 'SUBJECT_TEST' && exam.subject_id !== subject)
    throw new ApiError(422, 'ASSESSMENT_SUBJECT_MISMATCH', 'Use the subject of this test.');
}
export function parseResource(name: Resource, value: unknown) {
  return resourceSchemas[name].parse(value) as Record<string, unknown>;
}
