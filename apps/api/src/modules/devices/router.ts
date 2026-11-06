import { createHash } from 'node:crypto';
import { deviceOtaOffer } from './ota.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Router, json } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import {
  batchSchema,
  heartbeatSchema,
  syncAckSchema,
  otaSchema,
  uuid,
  deviceTuningSchema,
  type EventResult,
} from '@vidyalayaa/contracts';
import { deviceAuth, permission } from '../../middleware/auth.js';
import { transaction, audit } from '../../lib/db.js';
import { ApiError, asyncRoute, notFound } from '../../lib/errors.js';
import { equalHash, hash } from '../../lib/crypto.js';
import { processEvent } from '../attendance/service.js';
import { requireWrite } from '../school/router.js';
import { paged } from '../../lib/pagination.js';
function throttle(pool: pg.Pool, limit: number) {
  return asyncRoute(async (req, res, next) => {
    const retry = Number(
      (
        await pool.query('SELECT app.take_http_token($1,$2,60) AS retry', [
          hash('device:' + res.locals.device.id + ':' + req.path),
          limit,
        ])
      ).rows[0].retry,
    );
    if (retry) {
      res.setHeader('Retry-After', String(retry));
      throw new ApiError(429, 'RATE_LIMITED', 'Retry after the indicated delay.');
    }
    next();
  });
}
function mismatch(expected: string, actual: string) {
  if (expected !== actual)
    throw new ApiError(403, 'DEVICE_MISMATCH', 'Payload device_id must match X-Device-Id.');
}
export function deviceRouter(pool: pg.Pool, storage: SupabaseClient, releasePublicKey?: string) {
  const r = Router();
  r.use(deviceAuth(pool));
  r.post(
    '/events/batch',
    throttle(pool, 30),
    json({ limit: '256kb' }),
    asyncRoute(async (req, res) => {
      const b = batchSchema.parse(req.body),
        d = res.locals.device;
      mismatch(d.code, b.device_id);
      b.events.forEach((e) => mismatch(d.code, e.device_id));
      const results: EventResult[] = [];
      for (const e of b.events) {
        try {
          results.push(await processEvent(pool, d, e, res.locals.requestId));
        } catch {
          results.push({
            event_id: e.event_id,
            status: 'RETRY_LATER',
            notification_queued: false,
            device_action: 'RETAIN_AND_RETRY',
          });
        }
      }
      const cfg = await transaction(
        pool,
        { schoolId: d.schoolId, actorType: 'DEVICE' },
        async (tx) =>
          (
            await tx.query(
              'UPDATE devices SET last_seen_at=now(),last_sync_at=now(),firmware_version=$2 WHERE id=$1 RETURNING config_version',
              [d.id, b.firmware_version],
            )
          ).rows[0],
      );
      let ack = b.events[0].sequence_number - 1;
      for (let i = 0; i < results.length && results[i].device_action === 'DELETE'; i++) {
        if (b.events[i].sequence_number !== ack + 1) break;
        ack = b.events[i].sequence_number;
      }
      res.json({
        batch_id: b.batch_id,
        server_time: new Date().toISOString(),
        config_version: cfg.config_version,
        results,
        summary: {
          received: results.length,
          recorded: results.filter((x) => x.status === 'RECORDED').length,
          duplicate: results.filter((x) => x.status === 'DUPLICATE_EVENT').length,
          rejected: results.filter((x) => x.status === 'REJECTED').length,
          retry_later: results.filter((x) => x.status === 'RETRY_LATER').length,
        },
        ack_through_sequence: ack,
      });
    }),
  );
  r.get(
    '/ota/image/:version',
    throttle(pool, 6),
    asyncRoute(async (req, res) => {
      const d = res.locals.device,
        target = String(req.params.version);
      if (!/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(target))
        throw new ApiError(404, 'NOT_FOUND', 'Firmware is unavailable.');
      const offer = await transaction(
        pool,
        { schoolId: d.schoolId, actorType: 'DEVICE' },
        (tx) => deviceOtaOffer(tx, d.id, releasePublicKey),
        true,
      );
      if (!offer.available || offer.version !== target || !offer.storage_path)
        throw new ApiError(404, 'NOT_FOUND', 'Firmware is unavailable.');
      const object = await storage.storage.from('firmware').download(offer.storage_path);
      if (object.error)
        throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Firmware storage is unavailable.');
      const bytes = Buffer.from(await object.data.arrayBuffer());
      if (
        bytes.length !== offer.size ||
        createHash('sha256').update(bytes).digest('hex') !== offer.sha256
      )
        throw new ApiError(503, 'FIRMWARE_INTEGRITY', 'Firmware integrity check failed.');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', bytes.length);
      res.send(bytes);
    }),
  );
  r.post(
    '/heartbeat',
    throttle(pool, 6),
    json({ limit: '16kb' }),
    asyncRoute(async (req, res) => {
      const b = heartbeatSchema.parse(req.body),
        d = res.locals.device;
      mismatch(d.code, b.device_id);
      const now = new Date(),
        skew = new Date(b.device_time).getTime() - now.getTime();
      const row = await transaction(
        pool,
        { schoolId: d.schoolId, actorType: 'DEVICE' },
        async (tx) => {
          const prev = (
            await tx.query(
              'SELECT * FROM device_heartbeats WHERE device_id=$1 ORDER BY received_at DESC LIMIT 1',
              [d.id],
            )
          ).rows[0];
          if (
            !prev ||
            now.getTime() - prev.received_at.getTime() > 300000 ||
            prev.boot_id !== b.boot_id ||
            prev.reader_status !== b.reader_status ||
            prev.rtc_status !== b.rtc_status ||
            prev.pending_events !== b.pending_events
          )
            await tx.query(
              'INSERT INTO device_heartbeats(school_id,device_id,device_time,skew_ms,boot_id,uptime_ms,firmware_version,pending_events,storage_used_pct,wifi_rssi_dbm,reader_status,rtc_status,boot_reference_time,last_ntp_sync,reset_reason,config_version,oldest_pending_sequence,last_sequence,applied_config_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)',
              [
                d.schoolId,
                d.id,
                b.device_time,
                skew,
                b.boot_id,
                b.uptime_ms,
                b.firmware_version,
                b.pending_events,
                b.storage_used_pct,
                b.wifi_rssi_dbm,
                b.reader_status,
                b.rtc_status,
                new Date(now.getTime() - b.uptime_ms),
                b.last_ntp_sync,
                b.reset_reason,
                b.config_version,
                b.oldest_pending_sequence,
                b.last_sequence,
                b.config_version,
              ],
            );
          for (const l of b.logs)
            await tx.query(
              'INSERT INTO device_logs(school_id,device_id,device_ts,level,code,detail) VALUES($1,$2,$3,$4,$5,$6)',
              [d.schoolId, d.id, l.ts, l.level, l.code, l.detail || {}],
            );
          return (
            await tx.query(
              'UPDATE devices SET last_seen_at=now(),pending_event_count=$2,reader_status=$3,rtc_status=$4,wifi_rssi_dbm=$5,storage_used_pct=$6,firmware_version=$7 WHERE id=$1 RETURNING config_version',
              [
                d.id,
                b.pending_events,
                b.reader_status,
                Math.abs(skew) > 120000 ? 'DRIFT' : b.rtc_status,
                b.wifi_rssi_dbm,
                b.storage_used_pct,
                b.firmware_version,
              ],
            )
          ).rows[0];
        },
      );
      res.json({
        server_time: now.toISOString(),
        skew_ms: skew,
        config_version: row.config_version,
        ota: await transaction(pool, { schoolId: d.schoolId, actorType: 'DEVICE' }, async (tx) => {
          const { storage_path, ...offer } = await deviceOtaOffer(tx, d.id, releasePublicKey);
          return offer;
        }),
        alerts: [
          ...(Math.abs(skew) > 120000 ? ['RTC_DRIFT'] : []),
          ...(b.storage_used_pct >= 80 ? ['STORAGE_WARNING'] : []),
        ],
      });
    }),
  );
  r.get(
    '/config',
    throttle(pool, 6),
    asyncRoute(async (req, res) => {
      const d = res.locals.device,
        c = await transaction(
          pool,
          { schoolId: d.schoolId, actorType: 'DEVICE' },
          async (tx) =>
            (
              await tx.query(
                'SELECT d.config_version,d.config,l.name,l.location_type FROM devices d LEFT JOIN device_locations l ON l.school_id=d.school_id AND l.id=d.location_id WHERE d.id=$1',
                [d.id],
              )
            ).rows[0],
          true,
        );
      const etag = `"${c.config_version}"`;
      res.setHeader('ETag', etag);
      res.setHeader('X-Server-Time', new Date().toISOString());
      if (req.header('If-None-Match') === etag) {
        res.status(304).end();
        return;
      }
      res.json({
        server_time: new Date().toISOString(),
        config_version: c.config_version,
        heartbeat_interval_s: 60,
        batch_max_events: 50,
        batch_max_bytes: 100000,
        tap_debounce_ms: 1500,
        time_sync_interval_h: 6,
        storage_warn_pct: 80,
        ...c.config,
        feedback: {
          led_brightness: 60,
          buzzer: true,
          show_result_on_oled: false,
          ...c.config.feedback,
        },
        location: { name: c.name, type: c.location_type },
        ota: await transaction(
          pool,
          { schoolId: d.schoolId, actorType: 'DEVICE' },
          async (tx) => {
            const { storage_path, ...offer } = await deviceOtaOffer(tx, d.id, releasePublicKey);
            return offer;
          },
          true,
        ),
      });
    }),
  );
  r.post(
    '/sync-ack',
    throttle(pool, 30),
    json({ limit: '4kb' }),
    asyncRoute(async (req, res) => {
      const b = syncAckSchema.parse(req.body),
        d = res.locals.device;
      mismatch(d.code, b.device_id);
      const result = await transaction(
        pool,
        { schoolId: d.schoolId, actorType: 'DEVICE' },
        async (tx) => {
          const device = (
            await tx.query('SELECT last_purged_sequence FROM devices WHERE id=$1 FOR UPDATE', [
              d.id,
            ])
          ).rows[0];
          const old = Number(device.last_purged_sequence),
            end = b.purged_through_sequence;
          const count = Number(
            (
              await tx.query(
                "SELECT count(*) FROM attendance_events WHERE device_id=$1 AND sequence_number>$2 AND sequence_number<=$3 AND status IN ('RECORDED','REJECTED')",
                [d.id, old, end],
              )
            ).rows[0].count,
          );
          const gap = end > old && count !== end - old;
          if (!gap)
            await tx.query(
              'UPDATE devices SET last_purged_sequence=greatest(last_purged_sequence,$2),pending_event_count=$3 WHERE id=$1',
              [d.id, end, b.pending_events],
            );
          if (gap || b.queue_corruption_count > 0)
            await tx.query(
              "INSERT INTO device_logs(school_id,device_id,level,code,detail) VALUES($1,$2,'ERROR','SEQUENCE_GAP',$3)",
              [
                d.schoolId,
                d.id,
                { previous: old, purged: end, queue_corruption_count: b.queue_corruption_count },
              ],
            );
          if (gap || b.queue_corruption_count > 0)
            await tx.query('SELECT app.queue_device_security_alert($1,NULL,$2)', [
              gap ? 'SEQUENCE_GAP' : 'QUEUE_CORRUPTION',
              d.id,
            ]);
          return {
            gap_detected: gap,
            next_expected_sequence: (gap ? old : Math.max(old, end)) + 1,
          };
        },
      );
      res.json({ server_time: new Date().toISOString(), ...result });
    }),
  );
  r.post(
    '/ota/status',
    throttle(pool, 12),
    json({ limit: '4kb' }),
    asyncRoute(async (req, res) => {
      const b = otaSchema.parse(req.body),
        d = res.locals.device;
      mismatch(d.code, b.device_id);
      await transaction(pool, { schoolId: d.schoolId, actorType: 'DEVICE' }, (tx) =>
        tx.query(
          'INSERT INTO device_ota_status(school_id,device_id,target_version,state,detail) VALUES($1,$2,$3,$4,$5) ON CONFLICT(school_id,device_id,target_version) DO UPDATE SET state=EXCLUDED.state,detail=EXCLUDED.detail',
          [d.schoolId, d.id, b.target_version, b.state, b.detail],
        ),
      );
      res.setHeader('X-Server-Time', new Date().toISOString());
      res.status(204).end();
    }),
  );
  return r;
}
export function managementRouter(pool: pg.Pool) {
  const r = Router();
  r.use((_req, res, next) => {
    if (!res.locals.actor.features.nfc_attendance)
      return next(
        new ApiError(
          403,
          'SUBSCRIPTION_FEATURE_UNAVAILABLE',
          'Your current plan does not include NFC management.',
        ),
      );
    next();
  });
  r.get(
    '/',
    permission('devices.read'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor;
      res.json(
        await transaction(
          pool,
          a.context,
          (tx) =>
            paged(
              tx,
              "SELECT d.id,d.device_code,d.name,d.location_id,d.status,d.firmware_version,d.last_seen_at,d.pending_event_count,d.reader_status,d.rtc_status,d.storage_used_pct,d.wifi_rssi_dbm,d.config_version,d.config,l.name AS location_name,l.location_type,coalesce(d.status='ACTIVE' AND d.last_seen_at>=now()-make_interval(mins=>app.reader_offline_minutes(s.settings)),false) AS online FROM devices d JOIN schools s ON s.id=d.school_id LEFT JOIN device_locations l ON l.school_id=d.school_id AND l.id=d.location_id WHERE d.school_id=$1 ORDER BY d.name,d.id",
              [a.context.schoolId],
              req.query,
            ),
          true,
        ),
      );
    }),
  );
  r.get(
    '/:id/health',
    permission('devices.read'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        id = uuid.parse(req.params.id);
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => {
            if (
              !(
                await tx.query('SELECT id FROM devices WHERE school_id=$1 AND id=$2', [
                  a.context.schoolId,
                  id,
                ])
              ).rowCount
            )
              throw notFound();
            const kind = z.enum(['heartbeats', 'logs']).default('heartbeats').parse(req.query.kind);
            return paged(
              tx,
              kind === 'logs'
                ? 'SELECT id,received_at,level,code,detail FROM device_logs WHERE school_id=$1 AND device_id=$2 ORDER BY received_at DESC,id DESC'
                : 'SELECT id,received_at,pending_events,storage_used_pct,reader_status,rtc_status,wifi_rssi_dbm,last_ntp_sync,reset_reason,config_version,skew_ms FROM device_heartbeats WHERE school_id=$1 AND device_id=$2 ORDER BY received_at DESC,id DESC',
              [a.context.schoolId, id],
              req.query,
            );
          },
          true,
        ),
      );
    }),
  );
  r.get(
    '/:id/configurations',
    permission('devices.read'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        id = uuid.parse(req.params.id);
      res.json(
        await transaction(
          pool,
          a.context,
          async (tx) => {
            if (
              !(
                await tx.query('SELECT id FROM devices WHERE school_id=$1 AND id=$2', [
                  a.context.schoolId,
                  id,
                ])
              ).rowCount
            )
              throw notFound();
            return paged(
              tx,
              "SELECT h.id,h.version,h.config,h.created_at,u.full_name AS editor,(SELECT a.after->>'reason' FROM audit_logs a WHERE a.school_id=h.school_id AND a.entity_type='devices' AND a.entity_id=h.device_id AND a.action='device.configuration.updated' AND a.after->>'config_version'=h.version::text ORDER BY a.occurred_at DESC LIMIT 1) AS reason FROM device_configurations h LEFT JOIN users u ON u.id=h.created_by WHERE h.school_id=$1 AND h.device_id=$2 ORDER BY h.version DESC",
              [a.context.schoolId, id],
              req.query,
            );
          },
          true,
        ),
      );
    }),
  );
  r.post(
    '/claim',
    permission('devices.manage'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        b = z
          .object({
            device_code: z.string().max(64),
            claim_code: z.string().min(16).max(256),
            name: z.string().min(1).max(100),
            location_id: uuid,
          })
          .strict()
          .parse(req.body);
      res.json(
        await transaction(pool, a.context, async (tx) => {
          await requireWrite(tx, a, 'nfc_attendance');
          const d = (
            await tx.query(
              "SELECT * FROM devices WHERE school_id=$1 AND device_code=$2 AND status='PROVISIONED' FOR UPDATE",
              [a.context.schoolId, b.device_code],
            )
          ).rows[0];
          if (!d?.claim_code_hash || !equalHash(b.claim_code, d.claim_code_hash)) throw notFound();
          await tx.query("SELECT set_config('app.claim_verified','true',true)");
          return (
            await tx.query(
              "UPDATE devices SET name=$2,location_id=$3,status='ACTIVE',claim_code_hash=NULL,config_version=config_version+1 WHERE id=$1 RETURNING id,name,status",
              [d.id, b.name, b.location_id],
            )
          ).rows[0];
        }),
      );
    }),
  );
  r.patch(
    '/:id',
    permission('devices.manage'),
    asyncRoute(async (req, res) => {
      const a = res.locals.actor,
        id = uuid.parse(req.params.id),
        b = z
          .object({
            name: z.string().min(1).max(100),
            location_id: uuid,
            status: z.enum(['ACTIVE', 'DISABLED', 'REVOKED']),
            reason: z.string().min(5).max(1000),
            config: deviceTuningSchema.optional(),
          })
          .strict()
          .parse(req.body);
      res.json(
        await transaction(pool, a.context, async (tx) => {
          await requireWrite(tx, a, 'nfc_attendance');
          const d = (
            await tx.query('SELECT * FROM devices WHERE school_id=$1 AND id=$2 FOR UPDATE', [
              a.context.schoolId,
              id,
            ])
          ).rows[0];
          if (!d) throw notFound();
          if (d.status === 'PROVISIONED' && b.status !== 'REVOKED')
            throw new ApiError(
              409,
              'CLAIM_REQUIRED',
              'Claim this reader using its one-time claim code first.',
            );
          if (d.status === 'REVOKED')
            throw new ApiError(
              409,
              'DEVICE_REVOKED',
              'A revoked device requires platform reprovisioning.',
            );
          const updated = (
            await tx.query(
              "UPDATE devices SET name=$2,location_id=$3,status=$4,revoked_reason=$5,revoked_at=CASE WHEN $4='REVOKED' THEN now() ELSE NULL END,config=config||coalesce($6::jsonb,'{}'),config_version=config_version+1 WHERE id=$1 RETURNING id,name,status,config_version",
              [id, b.name, b.location_id, b.status, b.reason, b.config || null],
            )
          ).rows[0];
          await tx.query(
            "INSERT INTO audit_logs(school_id,actor_type,actor_id,action,entity_type,entity_id,after) VALUES($1,'USER',$2,'device.configuration.updated','devices',$3,$4)",
            [
              a.context.schoolId,
              a.id,
              id,
              { config_version: updated.config_version, reason: b.reason },
            ],
          );
          return updated;
        }),
      );
    }),
  );
  return r;
}
