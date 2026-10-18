# NFC device contract - SAS v1.0

Transport is HTTPS TLS 1.2+ with certificate-chain validation. Never use insecure TLS. Every request includes `X-Device-Id: DEV001` and `Authorization: Bearer <its unique secret>`. The server derives school and location from registration. Strict request schemas refuse school_id, student_id and unexpected fields. A device_id mismatch returns 403 DEVICE_MISMATCH. Devices hold no student directory and no database/provider credential.

| Endpoint | Body limit | Per-device/minute |
|---|---:|---:|
| POST /api/v1/device/events/batch | 256 KiB, 100 events | 30 |
| POST /api/v1/device/heartbeat | 16 KiB | 6 |
| GET /api/v1/device/config | no body | 6 |
| POST /api/v1/device/sync-ack | 4 KiB | 30 |
| POST /api/v1/device/ota/status | 4 KiB | 12 |

These limits are per API instance. Use a shared limiter before relying on global rate accuracy across scaled instances.

## Batch request

```json
{
  "batch_id": "b1f0a7c2-3e5d-4c91-8a47-0d6e2f9b1c58",
  "device_id": "DEV001",
  "firmware_version": "1.2.0",
  "sent_at": "2026-10-12T02:42:05.120Z",
  "events": [{
    "event_id": "9b2f6c1e-4d7a-4e53-8c19-2a7f5d3b8e60",
    "device_id": "DEV001",
    "card_uid": "04A2B3C4D5E680",
    "event_timestamp": "2026-10-12T02:42:03.412Z",
    "time_source": "RTC_SYNCED",
    "sequence_number": 48213,
    "boot_id": "c7d2e9a1-5b3f-4a86-9e10-3f8b6d2a7c45",
    "uptime_ms": 5231876,
    "firmware_version": "1.2.0"
  }]
}
```

Sequence numbers must ascend in each batch. UUID event_id is generated once per physical tap and persisted before feedback. Reuse it verbatim for every retry. Batch ID is informational; the idempotency key is `(device_id, device_event_id)`. One event has one transaction. The response is emitted only after its transaction commits. Never infer attendance from the reader's local clock/window; the server determines the business outcome.

```json
{
  "batch_id":"b1f0a7c2-3e5d-4c91-8a47-0d6e2f9b1c58",
  "server_time":"2026-10-12T02:42:05.480Z",
  "config_version":3,
  "results":[{
    "event_id":"9b2f6c1e-4d7a-4e53-8c19-2a7f5d3b8e60",
    "status":"RECORDED",
    "outcome":"ARRIVAL_ON_TIME",
    "attendance_status":"PRESENT",
    "movement_status":"ARRIVED",
    "notification_queued":true,
    "device_action":"DELETE"
  }],
  "summary":{"received":1,"recorded":1,"duplicate":0,"rejected":0,"retry_later":0},
  "ack_through_sequence":48213
}
```

RECORDED, DUPLICATE_EVENT and permanently REJECTED events return DELETE; RETRY_LATER returns RETAIN_AND_RETRY. A duplicate returns original_status, original_outcome and processed_at without creating another event or notification. Unknown/blocked cards are stored as REJECTED_UNKNOWN_CARD / REJECTED_CARD_BLOCKED. Other outcomes include arrival late/after cutoff, departure normal/half-day/early, reentry, repeat/cross-device ignored taps, classroom evidence, flagged ambiguous movement, QUARANTINED_TIMESTAMP, NO_SCHOOL_DAY and STORED_PENDING_RULES. Stored events awaiting rules or a boot reference can be reconciled by the worker.

Delete only UUIDs explicitly marked DELETE, and advance a durable purge cursor over a contiguous acknowledged prefix. Retain later acknowledged events if an earlier event still needs retry. `ack_through_sequence` reports only the accepted contiguous prefix of this response, not permission to delete unseen records. If the network fails after commit, retrying the same UUID safely returns DUPLICATE_EVENT.

## Time and replay

Use UTC in the DS3231 and payload. RTC_SYNCED/NTP instants within the seven-day offline window and clock tolerance are trusted. RTC_UNSYNCED/MONOTONIC events can be reconstructed only from the same boot_id's heartbeat server-time/uptime reference. UNKNOWN or implausible time is quarantined rather than applied at upload time. The server derives school-local date via its IANA timezone. Rule windows are start-inclusive/end-exclusive. Raw facts retain their original device/location snapshot; replay orders effective_ts, device UUID, sequence_number and respects applied manual overrides.

## Heartbeat

Body: device_id, boot_id, device_time (UTC ISO), uptime_ms, firmware_version, config_version, pending_events, oldest_pending_sequence (number/null), last_sequence, storage_used_pct 0-100, reader_status OK/DEGRADED/FAIL/UNKNOWN, rtc_status OK/DRIFT/LOST_POWER/UNKNOWN, last_ntp_sync (UTC ISO/null), wifi_rssi_dbm (number/null), reset_reason, logs (up to 20 `{ts,level:INFO|WARN|ERROR,code,detail?}`). Response: server_time, skew_ms, config_version, ota.available, alerts. Health history samples at five minutes or on a state/boot/queue change. Three minutes without a heartbeat is initially considered offline.

## Configuration, purge acknowledgement, OTA status

GET config supports `If-None-Match: "3"`, returns ETag and config_version, heartbeat/batch/debounce/time-sync/storage thresholds, feedback, location type/name and OTA channel. 304/204 responses provide X-Server-Time instead of a body. Config never contains a secret, child name or card directory.

POST sync-ack body: device_id, boot_id, purged_through_sequence, pending_events, queue_corruption_count. It reports gap_detected and next_expected_sequence. Only committed records count toward continuity; missing sequences/corruption produce a diagnostic alert. Purge acknowledgement is telemetry; the batch result is the authoritative event acknowledgement.

POST ota/status body: device_id, target_version, state OFFERED/DOWNLOADING/VERIFYING/INSTALLED/FAILED/ROLLED_BACK, detail object, reported_at. Target must exist in signed firmware inventory. Returns 204. The prototype does not install OTA images and the API currently offers no image; production signed OTA is an explicit hardware gate, not an unsigned fallback.

## Failure handling

- Network/5xx/RETRY_LATER: retain queue, capped exponential backoff with +/-25% jitter, honor Retry-After. One batch in flight per device. Default 50 events/~100 KiB.
- 413: halve batch; 429: honor Retry-After. Never delete a record because of either.
- 422 malformed request: quarantine locally after bounded retries, report diagnostic; retain attributable records for operator reconciliation.
- 401/403 credential/device revoked/disabled: keep queue, signal an operator, stop frequent upload attempts. Reprovisioning requires new credentials.
- Local full/corrupt storage: fail the write visibly; never overwrite pending records or display success.

Attendance ingestion is not gated by subscription features/state. Parent alerts may pause while the subscription is restricted, and stale alerts expire. This never deletes committed attendance.
