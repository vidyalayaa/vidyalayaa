import type { Tx } from '../../lib/db.js';
/** Called in the publication transaction, including draft-to-published edits. */
export async function scheduleAnnouncement(tx: Tx, schoolId: string, row: Record<string, any>) {
  // Cancel unsent obsolete versions. The worker also rechecks current publication before sending.
  await tx.query(
    "UPDATE notification_outbox SET status='COMPLETED',completed_at=now(),last_error='PUBLICATION_REPLACED',locked_until=NULL WHERE school_id=$1 AND kind='ANNOUNCEMENT' AND payload->>'announcement_id'=$2 AND status IN ('PENDING','PROCESSING')",
    [schoolId, row.id],
  );
  if (!row.published_at) return;
  await tx.query(
    `INSERT INTO notification_outbox(school_id,kind,dedupe_key,payload,next_attempt_at)
    VALUES($1,'ANNOUNCEMENT',$2,$3,greatest(now(),$4::timestamptz)) ON CONFLICT(school_id,dedupe_key) DO NOTHING`,
    [
      schoolId,
      `ANNOUNCEMENT:${row.id}:${row.publication_version}`,
      {
        announcement_id: row.id,
        publication_version: row.publication_version,
        class_id: row.class_id,
        audience: row.audience,
        title: row.title,
        event_time: row.published_at,
      },
      row.published_at,
    ],
  );
}
