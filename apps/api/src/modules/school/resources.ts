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
  exams: { class_id: 'classes' },
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
  exams: { read: 'marks.read', write: 'academics.write', search: ['name'], scope: 'class' },
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
export function studentScope(a: Actor, column: string, param: string) {
  const r = a.active!.role;
  if (r === 'parent')
    return `EXISTS(SELECT 1 FROM student_parents sp JOIN parents p ON p.school_id=sp.school_id AND p.id=sp.parent_id WHERE sp.school_id=t.school_id AND sp.student_id=${column} AND sp.status='ACTIVE' AND p.status='ACTIVE' AND p.user_id=${param})`;
  if (r === 'student')
    return `EXISTS(SELECT 1 FROM students own WHERE own.school_id=t.school_id AND own.id=${column} AND own.user_id=${param} AND own.status='ACTIVE')`;
  if (r === 'teacher')
    return `EXISTS(SELECT 1 FROM enrollments en JOIN teacher_class_assignments ta ON ta.school_id=en.school_id AND ta.class_id=en.class_id JOIN teachers te ON te.school_id=ta.school_id AND te.id=ta.teacher_id WHERE en.school_id=t.school_id AND en.student_id=${column} AND en.status='ACTIVE' AND te.user_id=${param} AND te.status='ACTIVE' AND ta.starts_on<=(now() AT TIME ZONE (SELECT timezone FROM schools WHERE id=t.school_id))::date AND (ta.ends_on IS NULL OR ta.ends_on>=(now() AT TIME ZONE (SELECT timezone FROM schools WHERE id=t.school_id))::date))`;
  return `${param}::uuid IS NOT NULL`;
}
export function classScope(a: Actor, column: string, param: string, subject?: string) {
  if (a.active!.role === 'teacher')
    return `EXISTS(SELECT 1 FROM teacher_class_assignments ta JOIN teachers te ON te.school_id=ta.school_id AND te.id=ta.teacher_id WHERE ta.school_id=t.school_id AND ta.class_id=${column} AND te.user_id=${param} AND te.status='ACTIVE' AND ta.starts_on<=(now() AT TIME ZONE (SELECT timezone FROM schools WHERE id=t.school_id))::date AND (ta.ends_on IS NULL OR ta.ends_on>=(now() AT TIME ZONE (SELECT timezone FROM schools WHERE id=t.school_id))::date)${subject ? ` AND (ta.subject_id IS NULL OR ta.subject_id=${subject})` : ''})`;
  if (['parent', 'student'].includes(a.active!.role))
    return `EXISTS(SELECT 1 FROM enrollments en WHERE en.school_id=t.school_id AND en.class_id=${column} AND en.status='ACTIVE' AND ${studentScope(a, 'en.student_id', param)})`;
  return `${param}::uuid IS NOT NULL`;
}
export function resourceScope(name: Resource, a: Actor, param = '$2') {
  const d = definitions[name];
  let scope = `${param}::uuid IS NOT NULL`;
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
    scope = `(t.class_id IS NULL OR ${classScope(a, 't.class_id', param)})${isFamily ? ` AND t.published_at<=now() AND t.audience IN ('SCHOOL','CLASS','PARENTS')` : ''}`;
  }
  if (name === 'marks')
    scope += ` AND EXISTS(SELECT 1 FROM exams ex WHERE ex.school_id=t.school_id AND ex.id=t.exam_id AND ${classScope(a, 'ex.class_id', param, 't.subject_id')}${['parent', 'student'].includes(a.active!.role) ? " AND ex.status='PUBLISHED'" : ''})`;
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
    const role = name === 'parents' ? 'parent' : name === 'teachers' ? 'teacher' : 'student';
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
    await assertClass(tx, a, ex.class_id, String(values.subject_id));
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
    if (!path.startsWith(`${a.context.schoolId}/materials/`) || path.includes('..'))
      throw new ApiError(422, 'INVALID_STORAGE_PATH', 'Material path must belong to this school.');
  }
  if (name === 'timetable_entries') {
    const conflict = await tx.query(
      'SELECT id FROM timetable_entries WHERE school_id=$1 AND weekday=$2 AND (teacher_id=$3 OR class_id=$4) AND starts_at<$6::time AND ends_at>$5::time AND id<>coalesce($7::uuid,gen_random_uuid()) FOR UPDATE',
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
export function parseResource(name: Resource, value: unknown) {
  return resourceSchemas[name].parse(value) as Record<string, unknown>;
}
