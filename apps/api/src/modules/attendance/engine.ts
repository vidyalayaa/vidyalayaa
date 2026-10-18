import type { AttendanceStatus, LocationType, RuleSet } from '@vidyalayaa/contracts';
export interface FoldEvent {
  id: string;
  device_id: string;
  sequence_number: number;
  effective_ts: Date;
  location_type: LocationType;
  timestamp_trust: string;
  status: string;
}
export interface DayState {
  attendance_status: AttendanceStatus;
  movement_status: 'NOT_ARRIVED' | 'ARRIVED' | 'LEFT';
  arrival_classification: 'ON_TIME' | 'LATE' | 'AFTER_CUTOFF' | null;
  departure_classification: 'NORMAL' | 'HALF_DAY' | 'EARLY' | null;
  first_arrival_at: Date | null;
  first_arrival_event_id: string | null;
  last_departure_at: Date | null;
  last_departure_event_id: string | null;
  last_applied_event_ts: Date | null;
  needs_review: boolean;
  departure_count: number;
}
export function localParts(at: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(at);
  const get = (name: string) => parts.find((x) => x.type === name)!.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}:${get('second')}`,
    weekday: get('weekday').toUpperCase(),
  };
}
export function emptyDay(): DayState {
  return {
    attendance_status: 'PENDING',
    movement_status: 'NOT_ARRIVED',
    arrival_classification: null,
    departure_classification: null,
    first_arrival_at: null,
    first_arrival_event_id: null,
    last_departure_at: null,
    last_departure_event_id: null,
    last_applied_event_ts: null,
    needs_review: false,
    departure_count: 0,
  };
}
export function trustedTime(
  event: { event_timestamp: string; time_source: string; uptime_ms?: number },
  received: Date,
  reference?: Date,
  maxClockSkewSeconds = 120,
) {
  const age = received.getTime() - new Date(event.event_timestamp).getTime();
  if (
    ['RTC_SYNCED', 'NTP'].includes(event.time_source) &&
    age >= -maxClockSkewSeconds * 1000 &&
    age <= 7 * 86400000
  )
    return { effective: new Date(event.event_timestamp), trust: 'TRUSTED' };
  if (
    reference &&
    ['RTC_UNSYNCED', 'MONOTONIC'].includes(event.time_source) &&
    event.uptime_ms !== undefined
  ) {
    const t = new Date(reference.getTime() + event.uptime_ms);
    if (
      t.getTime() <= received.getTime() + maxClockSkewSeconds * 1000 &&
      t.getTime() >= received.getTime() - 7 * 86400000
    )
      return { effective: t, trust: 'RECONSTRUCTED' };
  }
  return { effective: received, trust: 'SUSPECT' };
}
export function fold(
  events: FoldEvent[],
  rules: RuleSet,
  timezone: string,
  base?: DayState,
  previousAccepted?: FoldEvent,
) {
  const s = base ? { ...base } : emptyDay(),
    outcomes = new Map<string, string>();
  const notifications: { kind: string; eventId: string; at: Date; episode?: number }[] = [];
  let lastAccepted: FoldEvent | undefined = previousAccepted;
  const sorted = [...events].sort(
    (a, b) =>
      a.effective_ts.getTime() - b.effective_ts.getTime() ||
      a.device_id.localeCompare(b.device_id) ||
      a.sequence_number - b.sequence_number,
  );
  for (const e of sorted) {
    let outcome = 'FLAGGED_OUTSIDE_WINDOW';
    const t = localParts(e.effective_ts, timezone).time;
    const finish = (o: string) => outcomes.set(e.id, o);
    if (e.timestamp_trust === 'SUSPECT') {
      s.needs_review = true;
      finish('QUARANTINED_TIMESTAMP');
      continue;
    }
    if (e.status === 'REJECTED') continue;
    if (
      lastAccepted &&
      e.effective_ts.getTime() - lastAccepted.effective_ts.getTime() <
        rules.repeat_tap_debounce_seconds * 1000
    ) {
      finish(
        lastAccepted.device_id === e.device_id
          ? 'REPEAT_TAP_IGNORED'
          : 'DUPLICATE_TAP_OTHER_DEVICE_IGNORED',
      );
      continue;
    }
    if (t < rules.arrival.earliest_accept) {
      s.needs_review = true;
      finish('FLAGGED_TOO_EARLY');
      continue;
    }
    if (e.location_type === 'CLASSROOM' && !rules.classroom_tap_implies_arrival) {
      finish('CLASSROOM_PRESENCE_RECORDED');
      continue;
    }
    const arriving =
      e.location_type === 'ENTRY' ||
      e.location_type === 'CLASSROOM' ||
      (e.location_type === 'BIDIRECTIONAL' &&
        s.movement_status !== 'ARRIVED' &&
        t < rules.arrival.late_end);
    const leaving =
      e.location_type === 'EXIT' ||
      (e.location_type === 'BIDIRECTIONAL' &&
        s.movement_status === 'ARRIVED' &&
        t >= rules.departure.half_day.start);
    if (arriving) {
      if (s.movement_status === 'ARRIVED') {
        finish('REPEAT_TAP_IGNORED');
        continue;
      }
      if (s.movement_status === 'LEFT') {
        if (!rules.allow_reentry) {
          s.needs_review = true;
          finish('FLAGGED_OUTSIDE_WINDOW');
          continue;
        }
        s.movement_status = 'ARRIVED';
        outcome = 'REENTRY_RECORDED';
      } else {
        s.first_arrival_at = e.effective_ts;
        s.first_arrival_event_id = e.id;
        s.movement_status = 'ARRIVED';
        if (t < rules.arrival.on_time_end) {
          s.arrival_classification = 'ON_TIME';
          s.attendance_status = 'PRESENT';
          outcome = 'ARRIVAL_ON_TIME';
        } else if (t < rules.arrival.late_end) {
          s.arrival_classification = 'LATE';
          s.attendance_status = rules.late_counts_as;
          outcome = 'ARRIVAL_LATE';
        } else {
          s.arrival_classification = 'AFTER_CUTOFF';
          s.needs_review = true;
          outcome = 'ACCEPTED_AFTER_CUTOFF';
        }
        if (rules.notify.arrival && (outcome !== 'ARRIVAL_LATE' || rules.notify.late))
          notifications.push({ kind: 'STUDENT_ARRIVED', eventId: e.id, at: e.effective_ts });
      }
    } else if (leaving) {
      if (!s.first_arrival_at) {
        s.needs_review = true;
        finish('FLAGGED_DEPARTURE_WITHOUT_ARRIVAL');
        continue;
      }
      if (s.movement_status === 'LEFT') {
        finish('REPEAT_TAP_IGNORED');
        continue;
      }
      s.movement_status = 'LEFT';
      s.last_departure_at = e.effective_ts;
      s.last_departure_event_id = e.id;
      s.departure_count++;
      if (t >= rules.departure.normal.start) {
        s.departure_classification = 'NORMAL';
        outcome = 'DEPARTURE_NORMAL';
      } else if (t >= rules.departure.half_day.start && t < rules.departure.half_day.end) {
        s.departure_classification = 'HALF_DAY';
        if (s.arrival_classification !== 'AFTER_CUTOFF') s.attendance_status = 'HALF_DAY';
        outcome = 'DEPARTURE_HALF_DAY';
      } else {
        s.departure_classification = 'EARLY';
        s.needs_review = true;
        outcome = 'DEPARTURE_EARLY';
      }
      if (rules.notify.departure)
        notifications.push({
          kind: 'STUDENT_DEPARTED',
          eventId: e.id,
          at: e.effective_ts,
          episode: s.departure_count,
        });
    } else {
      s.needs_review = true;
      finish(outcome);
      continue;
    }
    s.last_applied_event_ts = e.effective_ts;
    lastAccepted = e;
    finish(outcome);
  }
  return { state: s, outcomes, notifications };
}
