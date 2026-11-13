import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createApp } from '../../apps/api/src/app.js';
import type { Config } from '../../apps/api/src/lib/config.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fixtureBearer, withProviderSessions } from '../helpers/provider-sessions.js';
import { fixture, poolAdapters, portableDatabase } from '../helpers/database.js';
import { transaction } from '../../apps/api/src/lib/db.js';
import {
  individualPerformance,
  publishedMarks,
} from '../../apps/api/src/modules/school/academic-records.js';
import { cohortData } from '../../apps/api/src/modules/school/academic-intelligence.js';
import {
  academicFacts,
  academicAi,
  assistantQuestion,
  analysisKey,
} from '../../apps/api/src/modules/school/academic-ai.js';

let db: PGlite;
let f: Awaited<ReturnType<typeof fixture>>;
let app: ReturnType<typeof createApp>;
const id = () => crypto.randomUUID();
const earlier = id(),
  current = id(),
  sibling = id(),
  other = id(),
  science = id(),
  otherClass = id(),
  otherTeacher = id();
const subjectTeacher = id(),
  subjectTeacherProfile = id();
const platform = id();

// Drive Express and its real authentication, routing and database middleware
// in process, without binding an operating-system port.
async function http(path: string, role: string, school = f.schoolA, body?: object) {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1' });
  const req = new IncomingMessage(socket);
  req.method = body ? 'POST' : 'GET';
  req.url = '/api/v1' + path;
  const token =
    role === 'platform'
      ? 'fixture.' +
        Buffer.from(JSON.stringify({ aal: 'aal2' })).toString('base64url') +
        '.platform'
      : role;
  req.headers = { authorization: 'Bearer ' + fixtureBearer(token) };
  if (role !== 'platform') req.headers['x-school-id'] = school;
  req.httpVersion = '1.1';
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;
  if (body) {
    const encoded = Buffer.from(JSON.stringify(body));
    req.headers['content-type'] = 'application/json';
    req.headers['content-length'] = String(encoded.length);
    req.push(encoded);
  }
  req.push(null);
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const res = new ServerResponse(req);
    res.end = ((chunk?: Buffer | string) => {
      try {
        resolve({ status: res.statusCode, body: chunk ? JSON.parse(chunk.toString()) : null });
      } catch (error) {
        reject(error);
      }
      return res;
    }) as typeof res.end;
    app(req, res);
  });
}
function read<T>(
  userId: string,
  query: Parameters<typeof transaction<T>>[2],
  schoolId = f.schoolA,
) {
  return transaction(poolAdapters(db).api, { schoolId, userId }, query, true);
}

beforeAll(async () => {
  db = await portableDatabase();
  f = await fixture(db);
  const identities: Record<string, string> = {
    admin: f.admin,
    principal: f.principal,
    teacher: f.teacher,
    subject: subjectTeacher,
    parent: f.parent,
    student: f.studentUser,
    platform,
  };
  const auth = {
    auth: {
      getUser: async (token: string) => ({
        data: { user: { id: identities[token.split('.').at(-1)!] } },
        error: null,
      }),
    },
  } as unknown as SupabaseClient;
  app = createApp(
    {
      NODE_ENV: 'test',
      WEB_ORIGINS: 'http://localhost:5173',
      TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
      TRUST_PROXY_HOPS: 0,
    } as Config,
    { ...poolAdapters(db), supabase: withProviderSessions(db, auth) },
  );
  await db.query(
    "INSERT INTO auth.users(id,email) VALUES($1,'academic-platform@example.invalid')",
    [platform],
  );
  await db.query("INSERT INTO platform_staff(user_id,platform_role) VALUES($1,'SUPER_ADMIN')", [
    platform,
  ]);
  await db.query('UPDATE schools SET settings=$2 WHERE id=$1', [
    f.schoolA,
    {
      result_policy: {
        pass_percentage: 40,
        grades: [
          { label: 'A', minimum: 75 },
          { label: 'B', minimum: 0 },
        ],
      },
    },
  ]);
  await db.query("INSERT INTO auth.users(id,email) VALUES($1,'subject-teacher@example.invalid')", [
    subjectTeacher,
  ]);
  await db.query(
    "INSERT INTO school_memberships(school_id,user_id,role_id,status) SELECT $1,$2,id,'ACTIVE' FROM roles WHERE code='teacher'",
    [f.schoolA, subjectTeacher],
  );
  await db.query(
    "INSERT INTO teachers(id,school_id,user_id,staff_code,full_name) VALUES($1,$2,$3,'SUBJECT-ONLY','Subject teacher'),($4,$2,NULL,'OTHER','Other teacher')",
    [subjectTeacherProfile, f.schoolA, subjectTeacher, otherTeacher],
  );
  await db.query(
    "INSERT INTO classes(id,school_id,academic_session_id,grade,section) VALUES($1,$2,$3,'8','B')",
    [otherClass, f.schoolA, f.session],
  );
  await db.query(
    "INSERT INTO teacher_class_assignments(school_id,teacher_id,class_id,subject_id,starts_on) VALUES($1,$2,$3,$4,'2026-01-01'),($1,$2,$5,$4,'2026-01-01')",
    [f.schoolA, subjectTeacherProfile, f.classId, f.subject, otherClass],
  );
  await db.query("INSERT INTO subjects(id,school_id,code,name) VALUES($1,$2,'SCI','Science')", [
    science,
    f.schoolA,
  ]);
  await db.query(
    "INSERT INTO students(id,school_id,student_code,first_name) VALUES($1,$3,'SIBLING','Linked sibling'),($2,$3,'OTHER','Unlinked student')",
    [sibling, other, f.schoolA],
  );
  for (const student of [sibling, other])
    await db.query(
      "INSERT INTO enrollments(school_id,student_id,class_id,academic_session_id,starts_on) VALUES($1,$2,$3,$4,'2026-01-01')",
      [f.schoolA, student, f.classId, f.session],
    );
  await db.query(
    "INSERT INTO student_parents(school_id,student_id,parent_id,relationship) VALUES($1,$2,$3,'GUARDIAN')",
    [f.schoolA, sibling, f.parentId],
  );
  for (const [exam, date, max] of [
    [earlier, '2026-03-03', 100],
    [current, '2026-05-05', 50],
  ] as const)
    await db.query(
      "INSERT INTO exams(id,school_id,class_id,name,exam_type,starts_on,max_score,status,assessment_kind) VALUES($1,$2,$3,$4::text,'UNIT',($4::text)::date,$5,'OPEN','OFFICIAL')",
      [exam, f.schoolA, f.classId, date, max],
    );
  for (const [exam, student, subject, score] of [
    [earlier, f.student, f.subject, 60],
    [earlier, f.student, science, 80],
    [current, f.student, f.subject, 40],
    [current, f.student, science, 30],
    [current, sibling, f.subject, 45],
    [current, other, f.subject, 49],
  ] as const)
    await db.query(
      'INSERT INTO marks(school_id,exam_id,student_id,subject_id,score,entered_by) VALUES($1,$2,$3,$4,$5,$6)',
      [f.schoolA, exam, student, subject, score, f.admin],
    );
  await db.query("UPDATE exams SET status='PUBLISHED' WHERE id=$1", [earlier]);
}, 120000);

afterAll(async () => {
  await db?.close();
});

it('refreshes a learner’s evidence after publication and uses normalized marks and official grades', async () => {
  const before = await read(f.studentUser, (tx) =>
    individualPerformance(tx, f.schoolA, f.student, undefined, 'student'),
  );
  expect(before.report.exam.id).toBe(earlier);
  await db.query("UPDATE exams SET status='PUBLISHED' WHERE id=$1", [current]);
  const after = await read(f.studentUser, (tx) =>
    individualPerformance(tx, f.schoolA, f.student, undefined, 'student'),
  );
  expect(after.report.exam.id).toBe(current);
  expect(after.report.student).toMatchObject({
    obtained: 70,
    maximum: 100,
    percentage: 70,
    class_position: { rank: 1 },
  });
  expect(after.report).toMatchObject({ grade: 'B', status: 'PASSED' });
  expect(after.subjects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'Mathematics',
        percentage: 80,
        previous: 60,
        change: 20,
        class_average: null,
      }),
      expect.objectContaining({ name: 'Science', percentage: 60, previous: 80, change: -20 }),
    ]),
  );
  expect(analysisKey(academicFacts(after))).not.toBe(analysisKey(academicFacts(before)));
  expect(JSON.stringify(academicFacts(after))).not.toMatch(
    /Test learner|STU001|Mathematics|Science/,
  );
  expect(assistantQuestion('How can I improve Maths? My name is Private', after)).toMatchObject({
    subject: 1,
  });
});

it('enforces student, multi-child parent, class teacher, subject teacher, leadership and tenant scope inside the database', async () => {
  const marks = (actor: string, school = f.schoolA, student: string | null = null) =>
    read(actor, (tx) => publishedMarks(tx, school, student), school);
  expect(new Set((await marks(f.parent)).map((row) => row.student_id))).toEqual(
    new Set([f.student, sibling]),
  );
  expect(await marks(f.parent, f.schoolA, other)).toEqual([]);
  expect(await marks(f.studentUser, f.schoolA, sibling)).toEqual([]);
  expect(await marks(f.admin, f.schoolB)).toEqual([]);
  expect((await marks(f.teacher)).some((row) => row.subject_id === science)).toBe(true);
  const teacherMarks = await marks(subjectTeacher);
  expect(teacherMarks.length).toBeGreaterThan(0);
  expect(teacherMarks.every((row) => row.subject_id === f.subject)).toBe(true);
  const parent = await read(f.parent, (tx) =>
    individualPerformance(tx, f.schoolA, sibling, current, 'parent'),
  );
  expect(parent.report.status).toBe('INCOMPLETE');
  expect(
    parent.report.subjects.find((subject) => subject.subject_id === science)?.score,
  ).toBeNull();
  const restricted = await read(subjectTeacher, (tx) =>
    individualPerformance(tx, f.schoolA, f.student, current, 'teacher'),
  );
  expect(restricted.report.subjects.map((subject) => subject.subject_id)).toEqual([f.subject]);
  expect(restricted.report.student.school_position).toBeNull();
  expect(restricted.report.grade).toBeNull();
  for (const actor of [f.admin, f.principal]) {
    const cohort = await read(actor, (tx) => cohortData(tx, f.schoolA, { exam_id: current }));
    expect(cohort).toMatchObject({ appeared: 3, passed: 1, failed: 0 });
    expect(cohort.standings).toHaveLength(3);
    expect(cohort.standings.find((row) => row.student_id === sibling)?.class_rank).toBeNull();
  }
});

it('stores progress under forced RLS and prevents linked parents from writing it', async () => {
  const plan = 'a'.repeat(64);
  const progress = (userId: string) =>
    read(
      userId,
      async (tx) =>
        (
          await tx.query(
            'SELECT task FROM academic_study_progress WHERE school_id=$1 AND student_id=$2',
            [f.schoolA, f.student],
          )
        ).rows,
    );
  const write = (userId: string, query: Parameters<typeof transaction>[2]) =>
    transaction(poolAdapters(db).api, { schoolId: f.schoolA, userId }, query);
  await write(f.studentUser, async (tx) => {
    await tx.query('INSERT INTO academic_study_plans VALUES($1,$2,$3,$4)', [
      f.schoolA,
      f.student,
      plan,
      { tasks: [{}] },
    ]);
    await tx.query('INSERT INTO academic_study_progress VALUES($1,$2,$3,0)', [
      f.schoolA,
      f.student,
      plan,
    ]);
  });
  expect(await progress(f.parent)).toEqual([{ task: 0 }]);
  expect(await progress(subjectTeacher)).toEqual([]);
  await expect(
    write(f.parent, (tx) =>
      tx.query('INSERT INTO academic_study_progress VALUES($1,$2,$3,1)', [
        f.schoolA,
        f.student,
        plan,
      ]),
    ),
  ).rejects.toThrow(/row-level security/);
});

it('rejects direct API requests outside the caller’s role and active school', async () => {
  const base = '/academic-intelligence';
  const performance = (student: string) =>
    `${base}/performance?student_id=${student}&exam_id=${current}`;
  expect((await http(performance(sibling), 'student')).status).toBe(404);
  expect((await http(performance(other), 'parent')).status).toBe(404);
  expect((await http(performance(sibling), 'parent')).status).toBe(200);
  expect((await http(`${base}/cohort`, 'parent')).status).toBe(404);
  expect((await http(`${base}/cohort`, 'student')).status).toBe(404);
  expect(
    (await http(`${base}/guidance`, 'parent', f.schoolA, { student_id: other, exam_id: current }))
      .status,
  ).toBe(404);
  expect(
    (await http(`${base}/guidance`, 'student', f.schoolA, { exam_id: current })).body,
  ).toMatchObject({
    error: { code: 'ACADEMIC_AI_UNCONFIGURED' },
  });
  expect((await http(`${base}/cohort`, 'admin')).status).toBe(200);
  expect((await http(`${base}/cohort`, 'principal')).status).toBe(200);
  expect((await http(`${base}/cohort`, 'admin', f.schoolB)).status).toBeGreaterThanOrEqual(400);
  const subject = await http(performance(f.student), 'subject');
  expect(subject.status).toBe(200);
  expect(
    subject.body.report.subjects.map((item: { subject_id: string }) => item.subject_id),
  ).toEqual([f.subject]);
  const grantId = id();
  const path = `/platform/support-grants/${grantId}/academic-intelligence`;
  expect((await http(path, 'platform')).status).toBe(404);
  await db.query(
    `INSERT INTO support_access_grants(id,school_id,staff_user_id,reason,ticket_ref,scope,approved_by,starts_at,expires_at)
     VALUES($1,$2,$3,'Academic support','TEST','["marks"]',$4,now(),now()+interval '1 hour')`,
    [grantId, f.schoolA, platform, f.admin],
  );
  const platformResult = await http(path, 'platform');
  expect(platformResult.status).toBe(200);
  expect(platformResult.body).toMatchObject({ appeared: 3, standings: [] });
});

it.skipIf(
  !process.env.ACADEMIC_AI_CLOUDFLARE_ACCOUNT_ID || !process.env.ACADEMIC_AI_CLOUDFLARE_TOKEN,
)(
  'generates real Cloudflare study guidance from published database records',
  async () => {
    const performance = await read(f.studentUser, (tx) =>
      individualPerformance(tx, f.schoolA, f.student, current, 'student'),
    );
    const facts = academicFacts(performance);
    const provider = academicAi({
      ACADEMIC_AI_CLOUDFLARE_ACCOUNT_ID: process.env.ACADEMIC_AI_CLOUDFLARE_ACCOUNT_ID,
      ACADEMIC_AI_CLOUDFLARE_TOKEN: process.env.ACADEMIC_AI_CLOUDFLARE_TOKEN,
    } as Config);
    const advice = await provider.advice(facts, analysisKey(facts));
    expect(advice.summary.length).toBeGreaterThan(0);
    expect(advice.tasks.every((task) => task.subject <= performance.subjects.length)).toBe(true);
  },
  90000,
);
