import type pg from 'pg';
import { transaction } from '../../api/src/lib/db.js';
import { processEvent } from '../../api/src/modules/attendance/service.js';
import type { DeviceEvent } from '@vidyalayaa/contracts';
export async function reconcileEvents(pool: pg.Pool, schoolId: string) {
  const rows = await transaction(
    pool,
    { schoolId, actorType: 'SYSTEM' },
    async (tx) =>
      (
        await tx.query(
          "SELECT e.*,d.device_code FROM attendance_events e JOIN devices d ON d.school_id=e.school_id AND d.id=e.device_id WHERE e.school_id=$1 AND e.outcome IN ('STORED_PENDING_RULES','QUARANTINED_TIMESTAMP') AND d.status='ACTIVE' AND (e.outcome='STORED_PENDING_RULES' OR EXISTS(SELECT 1 FROM device_heartbeats h WHERE h.school_id=e.school_id AND h.device_id=e.device_id AND h.boot_id=e.boot_id)) ORDER BY e.created_at LIMIT 50",
          [schoolId],
        )
      ).rows,
    true,
  );
  for (const row of rows) {
    const e: DeviceEvent = {
      event_id: row.device_event_id,
      device_id: row.device_code,
      card_uid: row.card_uid,
      event_timestamp: row.event_ts.toISOString(),
      time_source: row.time_source,
      sequence_number: Number(row.sequence_number),
      boot_id: row.boot_id,
      firmware_version: row.firmware_version,
      ...(row.uptime_ms === null ? {} : { uptime_ms: Number(row.uptime_ms) }),
    };
    await processEvent(
      pool,
      { id: row.device_id, schoolId, code: row.device_code, status: 'ACTIVE' },
      e,
      'worker-reconcile',
      true,
    );
  }
}
