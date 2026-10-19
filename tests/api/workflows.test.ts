import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PGlite } from '@electric-sql/pglite';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { createApp } from '../../apps/api/src/app.js';
import { processEvent } from '../../apps/api/src/modules/attendance/service.js';
import { sampleRule } from '../../apps/web/src/features/resources/metadata.js';
import type { Config } from '../../apps/api/src/lib/config.js';
import { hash } from '../../apps/api/src/lib/crypto.js';
let db: PGlite,
  pools: ReturnType<typeof poolAdapters>,
  f: Awaited<ReturnType<typeof fixture>>,
  app: ReturnType<typeof createApp>;
const config = {
  NODE_ENV: 'test',
  PORT: 4000,
  WEB_ORIGINS: 'http://localhost:5173',
  TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
  TRUST_PROXY_HOPS: 0,
} as Config;
beforeAll(async () => {
  db = await portableDatabase();
  pools = poolAdapters(db);
  f = await fixture(db);
  await db.query(
    "INSERT INTO attendance_rule_versions(school_id,day_type,version_no,effective_from,rules,created_by) VALUES($1,'REGULAR',1,'2026-01-01',$2,$3)",
    [f.schoolA, JSON.stringify({ ...sampleRule, weekly_off: [] }), f.admin],
  );
  await db.query(
    "INSERT INTO device_credentials(school_id,device_id,secret_hash,status) VALUES($1,$2,$3,'ACTIVE')",
    [f.schoolA, f.deviceA, Buffer.from(hash('fixture-only-device-secret'), 'hex')],
  );
  const auth = {
    auth: {
      getUser: async (token: string) => {
        const uid = {
          admin: f.admin,
          teacher: f.teacher,
          parent: f.parent,
          student: f.studentUser,
          principal: f.principal,
        }[token as 'admin'];
        return uid
          ? { data: { user: { id: uid } }, error: null }
          : { data: { user: null }, error: { message: 'invalid' } };
      },
    },
  } as unknown as SupabaseClient;
  app = createApp(config, { ...pools, supabase: auth });
});
afterAll(async () => {
  await db.close();
});
function call(method: 'get' | 'post' | 'patch', path: string, role = 'admin') {
  return request(app)
    [method]('/api/v1' + path)
    .set('Authorization', `Bearer ${role}`)
    .set('X-School-Id', f.schoolA);
}
describe('identity, RBAC and scope', () => {
  it('keeps audit cursor pages stable while new events arrive and validates cursors', async () => {
    for (let i = 0; i < 3; i++)
      await db.query(
        "INSERT INTO audit_logs(school_id,actor_type,actor_id,action,entity_type) VALUES($1,'USER',$2,'cursor.fixture','students')",
        [f.schoolA, f.admin],
      );
    const first = await call('get', '/audit?cursor=1&page_size=1');
    expect(first.status).toBe(200);
    expect(first.body.next_cursor).toBeTruthy();
    await db.query(
      "INSERT INTO audit_logs(school_id,actor_type,actor_id,action,entity_type) VALUES($1,'USER',$2,'cursor.new','students')",
      [f.schoolA, f.admin],
    );
    const next = await call(
      'get',
      `/audit?cursor=1&page=2&page_size=1&after=${first.body.next_cursor}`,
    );
    expect(next.status).toBe(200);
    expect(next.body.data[0].id).not.toBe(first.body.data[0].id);
    expect(next.body.data[0].action).toBe('cursor.fixture');
    expect((await call('get', '/audit?cursor=1&after=invalid')).status).toBe(422);
    expect((await call('get', '/audit?cursor=1', 'teacher')).status).toBe(403);
    const corrections = await call('get', '/corrections?cursor=1', 'teacher');
    expect(corrections.status).toBe(200);
    expect(corrections.body.data).toEqual([]);
  });
  it('hides a child’s notification history immediately when a parent link is revoked', async () => {
    const outbox = crypto.randomUUID();
    await db.query(
      "INSERT INTO notification_outbox(id,school_id,kind,student_id,dedupe_key,payload) VALUES($1,$2,'STUDENT_ARRIVED',$3,'scope-notification','{}')",
      [outbox, f.schoolA, f.student],
    );
    await db.query(
      "INSERT INTO notification_deliveries(school_id,outbox_id,parent_id,channel,status) VALUES($1,$2,$3,'EMAIL','SENT')",
      [f.schoolA, outbox, f.parentId],
    );
    expect((await call('get', '/notifications?cursor=1', 'parent')).body.data).toHaveLength(1);
    await db.query(
      "UPDATE student_parents SET status='REVOKED' WHERE school_id=$1 AND parent_id=$2",
      [f.schoolA, f.parentId],
    );
    expect((await call('get', '/notifications?cursor=1', 'parent')).body.data).toEqual([]);
    await db.query(
      "UPDATE student_parents SET status='ACTIVE' WHERE school_id=$1 AND parent_id=$2",
      [f.schoolA, f.parentId],
    );
    await db.query('DELETE FROM notification_deliveries WHERE outbox_id=$1', [outbox]);
    await db.query('DELETE FROM notification_outbox WHERE id=$1', [outbox]);
  });
  it('offers only active accounts in the requested school role to membership managers', async () => {
    const list = await call('get', '/lookups/accounts?role=teacher&page_size=100');
    expect(list.status).toBe(200);
    expect(list.body.data.map((x: { id: string }) => x.id)).toEqual([f.teacher]);
    expect((await call('get', '/lookups/accounts?role=teacher', 'teacher')).status).toBe(403);
    expect((await call('get', '/lookups/accounts?role=SUPER_ADMIN')).status).toBe(422);
    expect(
      (await call('get', '/lookups/accounts?role=teacher').set('X-School-Id', f.schoolB)).status,
    ).toBe(404);
  });
  it('resolves relation names on scoped records without broadening family access', async () => {
    const own = await call('get', '/resources/enrollments', 'parent');
    expect(own.status).toBe(200);
    expect(own.body.data[0].student_label).toContain('Test learner');
    expect(own.body.data[0].class_label).toBe('8 A');
    expect((await call('get', `/resources/students/${f.foreignStudent}`, 'parent')).status).toBe(
      404,
    );
  });
  it('rejects anonymous and forged identities', async () => {
    expect((await request(app).get('/api/v1/me')).status).toBe(401);
    expect((await call('get', '/me', 'forged')).status).toBe(401);
  });
  it('requires verified school membership even for a valid identity', async () => {
    expect((await call('get', '/me').set('X-School-Id', f.schoolB)).status).toBe(404);
  });
  it('returns the same 404 shape for foreign and nonexistent students', async () => {
    const foreign = await call('get', `/resources/students/${f.foreignStudent}`),
      missing = await call('get', `/resources/students/${crypto.randomUUID()}`);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error).toEqual(missing.body.error);
  });
  it('scopes parent and student dashboards to the linked student', async () => {
    for (const role of ['parent', 'student']) {
      const r = await call('get', '/resources/students', role);
      expect(r.status).toBe(200);
      expect(r.body.data.map((x: { id: string }) => x.id)).toEqual([f.student]);
    }
  });
  it('parents cannot write students or fee records', async () => {
    expect(
      (
        await call('post', '/resources/students', 'parent').send({
          student_code: 'HACK',
          first_name: 'X',
        })
      ).status,
    ).toBe(403);
    expect((await call('get', '/resources/parents', 'parent')).status).toBe(403);
  });
  it('teacher sees assigned classes, rejects writes in unassigned classes', async () => {
    expect((await call('get', '/resources/classes', 'teacher')).body.data).toHaveLength(1);
    expect(
      (
        await call('post', '/resources/assignments', 'teacher').send({
          class_id: crypto.randomUUID(),
          kind: 'HOMEWORK',
          title: 'Bad',
        })
      ).status,
    ).toBe(404);
  });
  it('revoking a parent link takes effect on the very next request', async () => {
    await db.query("UPDATE student_parents SET status='REVOKED' WHERE school_id=$1", [f.schoolA]);
    expect((await call('get', '/resources/students', 'parent')).body.data).toHaveLength(0);
    await db.query("UPDATE student_parents SET status='ACTIVE' WHERE school_id=$1", [f.schoolA]);
  });
  it('does not allow school users into platform operations', async () => {
    expect((await call('get', '/platform/schools')).status).toBe(403);
  });
});
describe('atomic writes and school workflows', () => {
  it('returns structured bulk mark row errors and saves none of a partly invalid upload', async () => {
    const exam = crypto.randomUUID(),
      subject = crypto.randomUUID();
    await db.query(
      "INSERT INTO exams(id,school_id,class_id,name,exam_type,max_score,status) VALUES($1,$2,$3,'Bulk validation','UNIT',100,'OPEN')",
      [exam, f.schoolA, f.classId],
    );
    await db.query(
      "INSERT INTO subjects(id,school_id,code,name) VALUES($1,$2,'BULK','Bulk subject')",
      [subject, f.schoolA],
    );
    const response = await call('post', '/marks/bulk').send({
      exam_id: exam,
      entries: [
        { student_id: f.student, subject_id: f.subject, score: 80 },
        { student_id: f.student, subject_id: subject, score: 120 },
      ],
    });
    expect(response.status).toBe(422);
    expect(response.body.error.details[0]).toMatchObject({ path: ['entries', 1, 'score'] });
    expect((await db.query('SELECT * FROM marks WHERE exam_id=$1', [exam])).rows).toEqual([]);
    const valid = {
      exam_id: exam,
      entries: [
        { student_id: f.student, subject_id: f.subject, score: 80 },
        { student_id: f.student, subject_id: subject, score: 90 },
      ],
    };
    expect((await call('post', '/marks/bulk', 'teacher').send(valid)).status).toBe(404);
    const key = crypto.randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      const saved = await call('post', '/marks/bulk').set('Idempotency-Key', key).send(valid);
      expect(saved.status).toBe(200);
      expect(saved.body.saved).toBe(2);
    }
    expect((await db.query('SELECT * FROM marks WHERE exam_id=$1', [exam])).rows).toHaveLength(2);
  });
  it('requires School Admin approval and a policy reference before enabling retention', async () => {
    const body = {
      policy_ref: 'SCHOOL-APPROVED-2026',
      report_days: 180,
      notification_days: 365,
      approved: true,
    };
    expect((await call('get', '/school/retention', 'parent')).status).toBe(403);
    expect(
      (
        await request(app)
          .put('/api/v1/school/retention')
          .set('Authorization', 'Bearer admin')
          .set('X-School-Id', f.schoolA)
          .send({ ...body, approved: false })
      ).status,
    ).toBe(422);
    const response = await request(app)
      .put('/api/v1/school/retention')
      .set('Authorization', 'Bearer admin')
      .set('X-School-Id', f.schoolA)
      .send(body);
    expect(response.status).toBe(200);
    expect(response.body.policy.approved_by).toBe(f.admin);
    expect((await call('get', '/school/retention')).body.policy.policy_ref).toBe(body.policy_ref);
    expect(
      (
        await request(app)
          .delete('/api/v1/school/retention')
          .set('Authorization', 'Bearer admin')
          .set('X-School-Id', f.schoolA)
      ).status,
    ).toBe(204);
    expect((await call('get', '/school/retention')).body.policy).toBeNull();
  });
  it('retains versioned device settings without dropping omitted tuning fields', async () => {
    const device = (await db.query('SELECT * FROM devices WHERE id=$1', [f.deviceA])).rows[0];
    const body = {
      name: device.name,
      location_id: device.location_id,
      status: 'ACTIVE',
      reason: 'Adjust heartbeat interval',
      config: { heartbeat_interval_s: 90 },
    };
    expect((await call('patch', `/devices/${f.deviceA}`).send(body)).status).toBe(200);
    expect(
      (
        await call('patch', `/devices/${f.deviceA}`).send({
          ...body,
          config: { tap_debounce_ms: 1500 },
        })
      ).status,
    ).toBe(200);
    const history = await call('get', `/devices/${f.deviceA}/configurations`);
    expect(history.status).toBe(200);
    expect(history.body.total).toBe(2);
    expect(history.body.data[0].config.heartbeat_interval_s).toBe(90);
    expect(history.body.data[0].config.tap_debounce_ms).toBe(1500);
    expect((await call('get', `/devices/${crypto.randomUUID()}/configurations`)).status).toBe(404);
    expect((await call('get', `/devices/${f.deviceA}/configurations`, 'parent')).status).toBe(403);
  });
  it('retries an idempotent create without duplication', async () => {
    const key = crypto.randomUUID(),
      body = { student_code: 'S2', first_name: 'Second' };
    const one = await call('post', '/resources/students').set('Idempotency-Key', key).send(body),
      two = await call('post', '/resources/students').set('Idempotency-Key', key).send(body);
    expect(one.status).toBe(201);
    expect(two.body.id).toBe(one.body.id);
    expect(
      (
        await call('post', '/resources/students')
          .set('Idempotency-Key', key)
          .send({ ...body, first_name: 'Changed' })
      ).status,
    ).toBe(409);
  });
  it('locks marks to open exams and enforces max score', async () => {
    const ex = await call('post', '/resources/exams').send({
      class_id: f.classId,
      name: 'Test exam',
      exam_type: 'UNIT',
      max_score: 100,
      status: 'OPEN',
    });
    expect(ex.status).toBe(201);
    const body = { student_id: f.student, exam_id: ex.body.id, subject_id: f.subject, score: 101 };
    expect((await call('post', '/resources/marks', 'teacher').send(body)).status).toBe(422);
    const valid = await call('post', '/resources/marks', 'teacher').send({ ...body, score: 95 });
    expect(valid.body.error).toBeUndefined();
    expect(valid.status).toBe(201);
    await call('patch', `/resources/exams/${ex.body.id}`).send({ status: 'LOCKED' });
    expect(
      (await call('post', '/resources/marks', 'teacher').send({ ...body, score: 90 })).status,
    ).toBe(409);
  });
  it('enforces subscription read-only without deleting data', async () => {
    await db.query("UPDATE subscriptions SET status='SUSPENDED_READONLY' WHERE school_id=$1", [
      f.schoolA,
    ]);
    expect(
      (await call('post', '/resources/students').send({ student_code: 'S3', first_name: 'Third' }))
        .status,
    ).toBe(403);
    expect((await call('get', '/resources/students')).status).toBe(200);
    await db.query("UPDATE subscriptions SET status='ACTIVE' WHERE school_id=$1", [f.schoolA]);
  });
});
describe('attendance transactions and corrections', () => {
  function event(seq: number, at = new Date()) {
    at = new Date(at.getTime() - 86400000);
    at.setUTCHours(2, 30, 0, 0);
    return {
      event_id: crypto.randomUUID(),
      device_id: 'DEV_A' + f.schoolA.slice(0, 8),
      card_uid: 'AABBCCDD',
      event_timestamp: at.toISOString(),
      time_source: 'RTC_SYNCED' as const,
      sequence_number: seq,
      boot_id: crypto.randomUUID(),
      firmware_version: '1.0.0',
    };
  }
  it('records an event, one daily row and one outbox, then safely returns its original result', async () => {
    const e = event(1),
      d = { id: f.deviceA, schoolId: f.schoolA, code: e.device_id, status: 'ACTIVE' };
    const one = await processEvent(pools.device, d, e, 'test'),
      two = await processEvent(pools.device, d, e, 'test');
    expect(one.outcome).toBe('ARRIVAL_ON_TIME');
    expect(two.status).toBe('DUPLICATE_EVENT');
    expect(
      (await db.query('SELECT * FROM daily_attendance WHERE school_id=$1', [f.schoolA])).rows,
    ).toHaveLength(1);
    expect(
      (
        await db.query(
          "SELECT * FROM notification_outbox WHERE school_id=$1 AND kind='STUDENT_ARRIVED'",
          [f.schoolA],
        )
      ).rows,
    ).toHaveLength(1);
  });
  it('stores unknown and blocked cards as permanent audit rejections', async () => {
    const e = event(2);
    e.card_uid = '11223344';
    expect(
      (
        await processEvent(
          pools.device,
          { id: f.deviceA, schoolId: f.schoolA, code: e.device_id, status: 'ACTIVE' },
          e,
          'test',
        )
      ).outcome,
    ).toBe('REJECTED_UNKNOWN_CARD');
  });
  it('prevents self-approval, applies a second reviewer correction, preserves raw facts', async () => {
    const day = (
      await db.query<{ id: string }>('SELECT id FROM daily_attendance WHERE school_id=$1', [
        f.schoolA,
      ])
    ).rows[0];
    const correction = await call('post', '/corrections', 'teacher').send({
      daily_attendance_id: day.id,
      requested_status: 'EXCUSED',
      reason: 'Verified medical leave',
    });
    expect(correction.status).toBe(201);
    expect(
      (
        await call('post', `/corrections/${correction.body.id}/decision`, 'teacher').send({
          approve: true,
        })
      ).status,
    ).toBe(403);
    const approved = await call(
      'post',
      `/corrections/${correction.body.id}/decision`,
      'principal',
    ).send({ approve: true });
    expect(approved.status).toBe(200);
    const row = (
      await db.query<{ manual_override: boolean; attendance_status: string }>(
        'SELECT * FROM daily_attendance WHERE id=$1',
        [day.id],
      )
    ).rows[0];
    expect(row.manual_override).toBe(true);
    expect(row.attendance_status).toBe('EXCUSED');
    expect(
      (await db.query('SELECT * FROM attendance_events WHERE school_id=$1', [f.schoolA])).rows
        .length,
    ).toBeGreaterThan(0);
  });
  it('preserves a manual attendance status while subsequent NFC movement continues', async () => {
    const e = event(3);
    const departure = new Date(e.event_timestamp);
    departure.setUTCHours(9, 0, 0, 0);
    e.event_timestamp = departure.toISOString();
    await db.query("UPDATE device_locations SET location_type='EXIT' WHERE school_id=$1", [
      f.schoolA,
    ]);
    const r = await processEvent(
      pools.device,
      { id: f.deviceA, schoolId: f.schoolA, code: e.device_id, status: 'ACTIVE' },
      e,
      'post-correction',
    );
    expect(r.attendance_status).toBe('EXCUSED');
    expect(r.movement_status).toBe('LEFT');
    const day = (
      await db.query<{ source: string; manual_override: boolean }>(
        'SELECT source,manual_override FROM daily_attendance WHERE school_id=$1',
        [f.schoolA],
      )
    ).rows[0];
    expect(day.source).toBe('MANUAL');
    expect(day.manual_override).toBe(true);
    await db.query("UPDATE device_locations SET location_type='ENTRY' WHERE school_id=$1", [
      f.schoolA,
    ]);
  });
});

describe('device HTTP contracts and revocation', () => {
  const code = () => `DEV_A${f.schoolA.slice(0, 8)}`;
  function deviceCall(method: 'get' | 'post', path: string) {
    return request(app)
      [method]('/api/v1/device' + path)
      .set('X-Device-Id', code())
      .set('Authorization', 'Bearer fixture-only-device-secret');
  }
  function batch() {
    const now = new Date(Date.now() - 86400000);
    return {
      batch_id: crypto.randomUUID(),
      device_id: code(),
      firmware_version: '1.0.0',
      sent_at: new Date().toISOString(),
      events: [
        {
          event_id: crypto.randomUUID(),
          device_id: code(),
          card_uid: '11223344',
          event_timestamp: now.toISOString(),
          time_source: 'RTC_SYNCED',
          sequence_number: 1000,
          boot_id: crypto.randomUUID(),
          firmware_version: '1.0.0',
        },
      ],
    };
  }
  it('acknowledges permanent audit rejections and returns the committed original on retry', async () => {
    const b = batch(),
      one = await deviceCall('post', '/events/batch').send(b),
      two = await deviceCall('post', '/events/batch').send(b);
    expect(one.status).toBe(200);
    expect(one.body.results[0].status).toBe('REJECTED');
    expect(one.body.results[0].device_action).toBe('DELETE');
    expect(two.body.results[0].status).toBe('DUPLICATE_EVENT');
  });
  it('rejects forged school fields, mismatched devices, oversize and 101-event payloads', async () => {
    const b = batch();
    expect(
      (await deviceCall('post', '/events/batch').send({ ...b, school_id: f.schoolB })).status,
    ).toBe(422);
    expect(
      (await deviceCall('post', '/events/batch').send({ ...b, device_id: 'OTHER' })).status,
    ).toBe(403);
    expect(
      (
        await deviceCall('post', '/events/batch').send({
          ...b,
          events: Array.from({ length: 101 }, (_, i) => ({
            ...b.events[0],
            event_id: crypto.randomUUID(),
            sequence_number: i + 2000,
          })),
        })
      ).status,
    ).toBe(422);
    expect(
      (await deviceCall('post', '/events/batch').send({ ...b, padding: 'x'.repeat(270000) }))
        .status,
    ).toBe(413);
  });
  it('configuration has no secret/student directory and supports conditional fetch', async () => {
    const r = await deviceCall('get', '/config');
    expect(r.status).toBe(200);
    expect(r.body.device_secret).toBeUndefined();
    expect(r.body.students).toBeUndefined();
    expect((await deviceCall('get', '/config').set('If-None-Match', r.headers.etag)).status).toBe(
      304,
    );
  });
  it('revocation takes effect on the next authenticated request', async () => {
    await db.query("UPDATE devices SET status='REVOKED' WHERE id=$1", [f.deviceA]);
    await db.query("UPDATE device_credentials SET status='REVOKED' WHERE device_id=$1", [
      f.deviceA,
    ]);
    const r = await deviceCall('get', '/config');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('DEVICE_REVOKED');
    await db.query("UPDATE devices SET status='ACTIVE' WHERE id=$1", [f.deviceA]);
    await db.query("UPDATE device_credentials SET status='ACTIVE' WHERE device_id=$1", [f.deviceA]);
  });
  it('gates unavailable plan features on reads as well as writes', async () => {
    await db.query(
      "UPDATE subscriptions SET plan_id=(SELECT id FROM subscription_plans WHERE code='BASIC') WHERE school_id=$1",
      [f.schoolA],
    );
    expect((await call('get', '/resources/assignments', 'teacher')).status).toBe(403);
    expect((await call('get', '/attendance', 'teacher')).status).toBe(200);
    await db.query(
      "UPDATE subscriptions SET plan_id=(SELECT id FROM subscription_plans WHERE code='PROFESSIONAL') WHERE school_id=$1",
      [f.schoolA],
    );
  });
});
