import { captureFailure } from '../../api/src/lib/monitoring.js';
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
          "SELECT e.*,d.device_code,(SELECT rr.id FROM attendance_reconciliation_requests rr WHERE rr.school_id=e.school_id AND rr.event_id=e.id AND (rr.status='PENDING' OR (rr.status='PROCESSING' AND rr.updated_at<now()-interval '5 minutes')) ORDER BY rr.created_at LIMIT 1) AS review_id FROM attendance_events e JOIN devices d ON d.school_id=e.school_id AND d.id=e.device_id WHERE e.school_id=$1 AND e.outcome IN ('STORED_PENDING_RULES','QUARANTINED_TIMESTAMP') AND (EXISTS(SELECT 1 FROM attendance_reconciliation_requests rr WHERE rr.school_id=e.school_id AND rr.event_id=e.id AND (rr.status='PENDING' OR (rr.status='PROCESSING' AND rr.updated_at<now()-interval '5 minutes'))) OR (d.status='ACTIVE' AND (e.outcome='STORED_PENDING_RULES' OR EXISTS(SELECT 1 FROM device_heartbeats h WHERE h.school_id=e.school_id AND h.device_id=e.device_id AND h.boot_id=e.boot_id)))) ORDER BY e.updated_at LIMIT 50",
          [schoolId],
        )
      ).rows,
    true,
  );
  for (const row of rows) {
    if (row.review_id) {
      const claim = await transaction(pool, { schoolId, actorType: 'SYSTEM' }, (tx) =>
        tx.query(
          "UPDATE attendance_reconciliation_requests SET status='PROCESSING',updated_at=now() WHERE id=$1 AND (status='PENDING' OR (status='PROCESSING' AND updated_at<now()-interval '5 minutes')) RETURNING id",
          [row.review_id],
        ),
      );
      if (!claim.rowCount) continue;
    }
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
    try {
      const result = await processEvent(
        pool,
        { id: row.device_id, schoolId, code: row.device_code, status: 'ACTIVE' },
        e,
        'worker-reconcile',
        true,
      );
      if (row.review_id)
        await transaction(pool, { schoolId, actorType: 'SYSTEM' }, (tx) =>
          tx.query(
            'UPDATE attendance_reconciliation_requests SET status=$2,result_code=$3 WHERE id=$1',
            [
              row.review_id,
              ['QUARANTINED_TIMESTAMP', 'STORED_PENDING_RULES'].includes(result.outcome || '')
                ? 'NEEDS_INFORMATION'
                : 'COMPLETED',
              result.outcome || result.status,
            ],
          ),
        );
    } catch (error) {
      captureFailure(error, 'RECONCILIATION_FAILED');
      if (row.review_id)
        await transaction(pool, { schoolId, actorType: 'SYSTEM' }, (tx) =>
          tx.query(
            "UPDATE attendance_reconciliation_requests SET status='FAILED',result_code='RECONCILIATION_FAILED' WHERE id=$1",
            [row.review_id],
          ),
        );
    }
  }
}
