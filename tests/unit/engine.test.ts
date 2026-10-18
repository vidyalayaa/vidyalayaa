import { describe, it, expect } from 'vitest';
import {
  fold,
  trustedTime,
  localParts,
  type FoldEvent,
} from '../../apps/api/src/modules/attendance/engine.js';
import { ruleSchema, batchSchema } from '@vidyalayaa/contracts';
import { sampleRule } from '../../apps/web/src/features/resources/metadata.js';
const rules = ruleSchema.parse(sampleRule);
function event(
  time: string,
  id = 'one',
  location_type: FoldEvent['location_type'] = 'ENTRY',
  device = 'A',
): FoldEvent {
  return {
    id,
    device_id: device,
    sequence_number: id === 'one' ? 1 : 2,
    effective_ts: new Date(`2026-10-12T${time}+05:30`),
    location_type,
    timestamp_trust: 'TRUSTED',
    status: 'RECORDED',
  };
}
describe('TEST-REQ-032 inclusive/exclusive school-local boundaries', () => {
  it.each([
    ['06:29:59.999', 'FLAGGED_TOO_EARLY'],
    ['06:30:00.000', 'ARRIVAL_ON_TIME'],
    ['07:59:59.999', 'ARRIVAL_ON_TIME'],
    ['08:00:00.000', 'ARRIVAL_ON_TIME'],
    ['08:29:59.999', 'ARRIVAL_ON_TIME'],
    ['08:30:00.000', 'ARRIVAL_LATE'],
    ['11:59:59.999', 'ARRIVAL_LATE'],
    ['12:00:00.000', 'ACCEPTED_AFTER_CUTOFF'],
  ])('%s => %s', (t, outcome) => {
    expect(fold([event(t)], rules, 'Asia/Kolkata').outcomes.get('one')).toBe(outcome);
  });
});
describe('attendance and movement', () => {
  it('departure never erases arrival or daily presence', () => {
    const { state } = fold(
      [event('08:00:00'), event('14:05:00', 'two', 'EXIT')],
      rules,
      'Asia/Kolkata',
    );
    expect(state.attendance_status).toBe('PRESENT');
    expect(state.movement_status).toBe('LEFT');
    expect(state.first_arrival_event_id).toBe('one');
  });
  it('half-day classification preserves the late arrival', () => {
    const { state } = fold(
      [event('08:31:00'), event('12:30:00', 'two', 'EXIT')],
      rules,
      'Asia/Kolkata',
    );
    expect(state.attendance_status).toBe('HALF_DAY');
    expect(state.arrival_classification).toBe('LATE');
  });
  it('simultaneous readers produce one arrival notification', () => {
    const result = fold(
      [event('08:00:00.000'), event('08:00:00.277', 'two', 'ENTRY', 'B')],
      rules,
      'Asia/Kolkata',
    );
    expect(result.notifications).toHaveLength(1);
    expect(result.outcomes.get('two')).toBe('DUPLICATE_TAP_OTHER_DEVICE_IGNORED');
  });
  it('TEST-REQ-030 replays out-of-order facts deterministically', () => {
    const arrival = event('08:00:00'),
      exit = event('14:20:00', 'two', 'EXIT', 'B');
    expect(fold([exit, arrival], rules, 'Asia/Kolkata')).toEqual(
      fold([arrival, exit], rules, 'Asia/Kolkata'),
    );
    expect(fold([exit, arrival], rules, 'Asia/Kolkata').notifications).toHaveLength(2);
  });
  it('classroom evidence does not silently create gate arrival', () => {
    const r = fold([event('09:00:00', 'one', 'CLASSROOM')], rules, 'Asia/Kolkata');
    expect(r.state.movement_status).toBe('NOT_ARRIVED');
    expect(r.notifications).toHaveLength(0);
  });
  it('ambiguous bidirectional taps are flagged', () => {
    const r = fold(
      [event('08:00:00'), event('10:00:00', 'two', 'BIDIRECTIONAL')],
      rules,
      'Asia/Kolkata',
    );
    expect(r.state.movement_status).toBe('ARRIVED');
    expect(r.outcomes.get('two')).toBe('FLAGGED_OUTSIDE_WINDOW');
  });
  it('reentry retains the first arrival and numbers departure episodes', () => {
    const events = [
      event('08:00:00'),
      event('12:30:00', 'two', 'EXIT'),
      event('13:10:00', 'three', 'ENTRY'),
      event('14:20:00', 'four', 'EXIT'),
    ];
    const r = fold(events, rules, 'Asia/Kolkata');
    expect(r.state.first_arrival_event_id).toBe('one');
    expect(r.state.departure_count).toBe(2);
  });
});
describe('timestamp trust', () => {
  const received = new Date('2026-10-12T05:00:00Z');
  it('accepts valid offline RTC timestamps', () => {
    expect(
      trustedTime({ event_timestamp: '2026-10-11T05:00:00Z', time_source: 'RTC_SYNCED' }, received)
        .trust,
    ).toBe('TRUSTED');
  });
  it('quarantines a timestamp beyond the offline window', () => {
    expect(
      trustedTime({ event_timestamp: '2000-01-01T00:00:00Z', time_source: 'RTC_SYNCED' }, received)
        .trust,
    ).toBe('SUSPECT');
  });
  it('reconstructs time from a heartbeat in the same boot', () => {
    expect(
      trustedTime(
        { event_timestamp: '2000-01-01T00:00:00Z', time_source: 'MONOTONIC', uptime_ms: 1000 },
        received,
        new Date('2026-10-12T04:00:00Z'),
      ).effective.toISOString(),
    ).toBe('2026-10-12T04:00:01.000Z');
  });
  it('is independent of host timezone', () => {
    expect(localParts(new Date('2026-10-11T22:31:00Z'), 'Asia/Kolkata').date).toBe('2026-10-12');
  });
});

it('incremental projection matches a full chronological replay', () => {
  const arrival = event('08:00:00'),
    departure = event('14:05:00', 'two', 'EXIT');
  const first = fold([arrival], rules, 'Asia/Kolkata'),
    incremental = fold([departure], rules, 'Asia/Kolkata', first.state, arrival),
    full = fold([arrival, departure], rules, 'Asia/Kolkata');
  expect(incremental.state).toEqual(full.state);
  expect([...first.notifications, ...incremental.notifications]).toEqual(full.notifications);
});
