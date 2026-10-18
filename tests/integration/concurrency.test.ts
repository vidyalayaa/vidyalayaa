import { beforeAll, afterAll, it, expect } from 'vitest';
import pg from 'pg';
import type { PGlite } from '@electric-sql/pglite';
import { fixture } from '../helpers/database.js';
import { processEvent } from '../../apps/api/src/modules/attendance/service.js';
import { sampleRule } from '../../apps/web/src/features/resources/metadata.js';
const url = process.env.TEST_DATABASE_URL;
if (process.env.CI && !url)
  throw new Error('CI must provide TEST_DATABASE_URL for multi-connection PostgreSQL tests.');
let admin: pg.Pool, device: pg.Pool, f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith('_test'))
    throw new Error('Integration tests require an isolated _test database.');
  admin = new pg.Pool({ connectionString: url, ssl: false });
  device = new pg.Pool({
    connectionString: url,
    ssl: false,
    max: 10,
    options: '-c role=app_device',
  });
  f = await fixture(admin as unknown as Pick<PGlite, 'query'>);
  await admin.query(
    "INSERT INTO attendance_rule_versions(school_id,day_type,version_no,effective_from,rules,created_by) VALUES($1,'REGULAR',1,'2026-01-01',$2,$3)",
    [f.schoolA, JSON.stringify({ ...sampleRule, weekly_off: [] }), f.admin],
  );
});
afterAll(async () => {
  await Promise.all([admin?.end(), device?.end()]);
});
it.skipIf(!url)(
  'TEST-REQ-011/012: five concurrent readers and repeated events preserve one day and one arrival outbox',
  async () => {
    const devices = [f.deviceA, f.deviceB];
    for (let i = 2; i < 5; i++) {
      const id = crypto.randomUUID();
      await admin.query(
        "INSERT INTO devices(id,school_id,device_code,name,location_id,status) SELECT $1,school_id,$2,$2,location_id,'ACTIVE' FROM devices WHERE id=$3",
        [id, `SIM_${id}`, f.deviceA],
      );
      devices.push(id);
    }
    const timestamp = new Date(Date.now() - 86400000);
    timestamp.setUTCHours(2, 30, 0, 0);
    let seq = 1;
    for (
      let iteration = 0;
      iteration < Number(process.env.CONCURRENCY_ITERATIONS || 1000);
      iteration++
    ) {
      const input = devices.map((id) => ({
        device: { id, schoolId: f.schoolA, code: id, status: 'ACTIVE' },
        event: {
          event_id: crypto.randomUUID(),
          device_id: id,
          card_uid: 'AABBCCDD',
          event_timestamp: new Date(timestamp.getTime() + iteration * 1000).toISOString(),
          time_source: 'RTC_SYNCED' as const,
          sequence_number: seq,
          boot_id: crypto.randomUUID(),
          firmware_version: 'test',
        },
      }));
      seq++;
      const results = await Promise.all(
        input.map((x) => processEvent(device, x.device, x.event, 'concurrency')),
      );
      expect(results.every((x) => x.device_action === 'DELETE')).toBe(true);
      if (iteration === 0) {
        const repeat = await Promise.all(
          Array.from({ length: 10 }, () =>
            processEvent(device, input[0].device, input[0].event, 'retry'),
          ),
        );
        expect(repeat.every((x) => x.status === 'DUPLICATE_EVENT')).toBe(true);
      }
    }
    expect(
      Number(
        (await admin.query('SELECT count(*) FROM daily_attendance WHERE school_id=$1', [f.schoolA]))
          .rows[0].count,
      ),
    ).toBe(1);
    expect(
      Number(
        (
          await admin.query(
            "SELECT count(*) FROM notification_outbox WHERE school_id=$1 AND kind='STUDENT_ARRIVED'",
            [f.schoolA],
          )
        ).rows[0].count,
      ),
    ).toBe(1);
  },
  600000,
);
it.skipIf(!url)(
  'TEST-REQ-030: late arrival upload replays an earlier EXIT into the correct final movement',
  async () => {
    await admin.query("UPDATE device_locations SET location_type='EXIT' WHERE school_id=$1", [
      f.schoolA,
    ]);
    const exitTime = new Date(Date.now() - 2 * 86400000);
    exitTime.setUTCHours(9, 0, 0, 0);
    const arrivalTime = new Date(exitTime);
    arrivalTime.setUTCHours(2, 30, 0, 0);
    const make = (id: string, time: Date) => ({
      event_id: crypto.randomUUID(),
      device_id: id,
      card_uid: 'AABBCCDD',
      event_timestamp: time.toISOString(),
      time_source: 'RTC_SYNCED' as const,
      sequence_number: 100000,
      boot_id: crypto.randomUUID(),
      firmware_version: 'test',
    });
    await processEvent(
      device,
      { id: f.deviceB, schoolId: f.schoolA, code: 'B', status: 'ACTIVE' },
      make(f.deviceB, exitTime),
      'exit-first',
    );
    await admin.query("UPDATE device_locations SET location_type='ENTRY' WHERE school_id=$1", [
      f.schoolA,
    ]);
    await processEvent(
      device,
      { id: f.deviceA, schoolId: f.schoolA, code: 'A', status: 'ACTIVE' },
      make(f.deviceA, arrivalTime),
      'arrival-later',
    );
    const row = (
      await admin.query(
        "SELECT * FROM daily_attendance WHERE school_id=$1 AND attendance_date=($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date",
        [f.schoolA, arrivalTime],
      )
    ).rows[0];
    expect(row.movement_status).toBe('LEFT');
    expect(row.attendance_status).toBe('PRESENT');
  },
);
