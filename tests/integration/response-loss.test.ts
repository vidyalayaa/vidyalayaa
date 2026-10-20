import { beforeAll, afterAll, it, expect } from 'vitest';
import pg from 'pg';
import type { PGlite } from '@electric-sql/pglite';
import { fixture } from '../helpers/database.js';
import { processEvent } from '../../apps/api/src/modules/attendance/service.js';
import { sampleRule } from '../../apps/web/src/features/resources/metadata.js';
const url = process.env.TEST_DATABASE_URL;
let owner: pg.Pool, device: pg.Pool, f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  if (!url) return;
  if (!new URL(url).pathname.endsWith('_test')) throw new Error('ISOLATED_TEST_DATABASE_REQUIRED');
  owner = new pg.Pool({ connectionString: url, ssl: false });
  device = new pg.Pool({ connectionString: url, ssl: false, options: '-c role=app_device' });
  f = await fixture(owner as unknown as Pick<PGlite, 'query'>);
  await owner.query(
    "INSERT INTO attendance_rule_versions(school_id,day_type,version_no,effective_from,rules,created_by) VALUES($1,'REGULAR',1,'2026-01-01',$2,$3)",
    [f.schoolA, JSON.stringify({ ...sampleRule, weekly_off: [] }), f.admin],
  );
});
afterAll(async () => {
  await device?.end();
  await owner?.end();
});
it.skipIf(!url)(
  'survives a lost commit acknowledgement with the original UUID and one committed fact',
  async () => {
    let lost = false;
    const failing = {
      connect: async () => {
        const client = await device.connect();
        return {
          query: async (sql: string, args?: unknown[]) => {
            const result = await client.query(sql, args);
            if (sql === 'COMMIT' && !lost) {
              lost = true;
              throw new Error('SIMULATED_RESPONSE_LOSS');
            }
            return result;
          },
          release: () => client.release(),
        };
      },
    } as unknown as pg.Pool;
    const at = new Date();
    at.setUTCHours(2, 30, 0, 0);
    const e = {
        event_id: crypto.randomUUID(),
        device_id: 'DEV_A',
        card_uid: 'AABBCCDD',
        event_timestamp: at.toISOString(),
        time_source: 'RTC_SYNCED' as const,
        sequence_number: 1,
        boot_id: crypto.randomUUID(),
        firmware_version: 'test',
      },
      d = { id: f.deviceA, schoolId: f.schoolA, code: 'DEV_A', status: 'ACTIVE' };
    await expect(processEvent(failing, d, e, 'response-loss')).rejects.toThrow(
      'SIMULATED_RESPONSE_LOSS',
    );
    const retry = await processEvent(device, d, e, 'response-retry');
    expect(retry.status).toBe('DUPLICATE_EVENT');
    expect(retry.device_action).toBe('DELETE');
    expect(
      Number(
        (
          await owner.query(
            'SELECT count(*) FROM attendance_events WHERE school_id=$1 AND device_event_id=$2',
            [f.schoolA, e.event_id],
          )
        ).rows[0].count,
      ),
    ).toBe(1);
    expect(
      Number(
        (
          await owner.query(
            "SELECT count(*) FROM notification_outbox WHERE school_id=$1 AND kind='STUDENT_ARRIVED'",
            [f.schoolA],
          )
        ).rows[0].count,
      ),
    ).toBe(1);
  },
);
