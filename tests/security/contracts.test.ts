import { it, expect } from 'vitest';
import { batchSchema, eventSchema, resourceSchemas, ruleSchema } from '@vidyalayaa/contracts';
import { sampleRule } from '../../apps/web/src/features/resources/metadata.js';
const e = {
  event_id: '10000000-0000-4000-8000-000000000001',
  device_id: 'DEV001',
  card_uid: '04A2B3C4D5E680',
  event_timestamp: '2026-10-12T02:42:03.412Z',
  time_source: 'RTC_SYNCED',
  sequence_number: 1,
  boot_id: '20000000-0000-4000-8000-000000000001',
  firmware_version: '1.2.0',
};
it('rejects forged tenant and student fields on device events', () => {
  expect(eventSchema.safeParse({ ...e, school_id: crypto.randomUUID() }).success).toBe(false);
  expect(eventSchema.safeParse({ ...e, student_id: crypto.randomUUID() }).success).toBe(false);
});
it('accepts the specification UID example', () => {
  expect(eventSchema.safeParse(e).success).toBe(true);
});
it('rejects oversize and out-of-order batches', () => {
  const b = {
    batch_id: crypto.randomUUID(),
    device_id: 'DEV001',
    firmware_version: '1.2.0',
    sent_at: e.event_timestamp,
    events: Array.from({ length: 101 }, (_, i) => ({
      ...e,
      event_id: crypto.randomUUID(),
      sequence_number: i + 1,
    })),
  };
  expect(batchSchema.safeParse(b).success).toBe(false);
  expect(batchSchema.safeParse({ ...b, events: [{ ...e, sequence_number: 2 }, e] }).success).toBe(
    false,
  );
});
it('rejects role escalation and injected SQL columns in student input', () => {
  expect(
    resourceSchemas.students.safeParse({
      student_code: 'S1',
      first_name: 'A',
      role: 'school_admin',
    }).success,
  ).toBe(false);
});
it('rejects impossible attendance windows', () => {
  expect(
    ruleSchema.safeParse({
      ...sampleRule,
      arrival: { ...sampleRule.arrival, on_time_end: '06:00' },
    }).success,
  ).toBe(false);
});
