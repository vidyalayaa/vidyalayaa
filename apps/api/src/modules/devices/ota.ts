import { Router } from 'express';
import type pg from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import multer from 'multer';
import { createHash, createPublicKey, verify, constants } from 'node:crypto';
import {
  uuid,
  firmwareVersionSchema as version,
  firmwareManifestSchema as metadata,
  firmwareApprovalSchema,
  hardwareVerificationSchema,
  firmwareAssignmentSchema,
} from '@vidyalayaa/contracts';
import { platformOnly } from '../../middleware/auth.js';
import { asyncRoute, ApiError, notFound } from '../../lib/errors.js';
import { platformTx, type Tx } from '../../lib/db.js';
import { paged } from '../../lib/pagination.js';
export function firmwareKeyId(publicKey?: string) {
  if (!publicKey) return undefined;
  if (!publicKey.includes('-----BEGIN PUBLIC KEY-----'))
    throw new ApiError(
      503,
      'FIRMWARE_SIGNING_UNCONFIGURED',
      'Only the approved public signing key belongs on the API.',
    );
  const key = createPublicKey(publicKey.replace(/\\n/g, '\n'));
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 3072)
    throw new ApiError(
      503,
      'FIRMWARE_SIGNING_UNCONFIGURED',
      'Configure the approved RSA-3072 release public key.',
    );
  return createHash('sha256')
    .update(key.export({ type: 'spki', format: 'der' }))
    .digest('hex');
}
export async function deviceOtaOffer(
  tx: Tx,
  id: string,
  publicKey?: string,
): Promise<{
  available: boolean;
  version?: string;
  sha256?: string;
  size?: number;
  security_version?: number;
  hardware_model?: string;
  url?: string;
  storage_path?: string;
}> {
  const fingerprint = firmwareKeyId(publicKey);
  if (!fingerprint) return { available: false };
  const offer = (
    await tx.query(
      "SELECT f.version,f.sha256,f.size,f.security_version,f.hardware_model,f.storage_path FROM device_ota_assignments a JOIN devices d ON d.school_id=a.school_id AND d.id=a.device_id JOIN firmware_releases f ON f.version=a.version WHERE a.device_id=$1 AND f.signing_key_fingerprint=$2 AND a.enabled AND f.enabled AND d.status='ACTIVE' AND d.hardware_verified_at IS NOT NULL AND d.verified_chip_revision>=300 AND d.verified_flash_bytes=4194304 AND d.hardware_model=f.hardware_model AND d.firmware_version IS DISTINCT FROM f.version ORDER BY a.created_at DESC LIMIT 1",
      [id, fingerprint],
    )
  ).rows[0];
  return offer
    ? {
        available: true,
        version: offer.version,
        sha256: offer.sha256,
        size: Number(offer.size),
        security_version: offer.security_version,
        hardware_model: offer.hardware_model,
        url: '/api/v1/device/ota/image/' + offer.version,
        storage_path: offer.storage_path,
      }
    : { available: false };
}
export function firmwareRouter(pool: pg.Pool, storage: SupabaseClient, publicKey?: string) {
  const r = Router();
  r.use(platformOnly);
  r.get(
    '/firmware-releases',
    asyncRoute(async (req, res) =>
      res.json(
        await platformTx(pool, res.locals.actor.id, (tx) =>
          paged(
            tx,
            'SELECT version,channel,sha256,size,security_version,hardware_model,enabled,pipeline_ref,created_at FROM firmware_releases ORDER BY created_at DESC,version',
            [],
            req.query,
          ),
        ),
      ),
    ),
  );
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 0x130000, files: 1, fields: 1, fieldSize: 16384 },
  });
  r.post(
    '/firmware-releases',
    upload.single('image'),
    asyncRoute(async (req, res) => {
      if (!publicKey)
        throw new ApiError(
          503,
          'FIRMWARE_SIGNING_UNCONFIGURED',
          'Configure the approved firmware release public key first.',
        );
      let raw: unknown;
      try {
        raw = JSON.parse(req.body.manifest);
      } catch {
        throw new ApiError(422, 'INVALID_MANIFEST', 'Supply the signed firmware manifest.');
      }
      const b = metadata.parse(raw),
        file = req.file?.buffer;
      if (!file || file.length < 1024 || file[0] !== 0xe9)
        throw new ApiError(
          422,
          'INVALID_FIRMWARE_IMAGE',
          'Select an ESP-IDF signed application image.',
        );
      const key = createPublicKey(publicKey.replace(/\\n/g, '\n'));
      if (
        key.asymmetricKeyType !== 'rsa' ||
        key.asymmetricKeyDetails?.modulusLength !== 3072 ||
        createHash('sha256').update(file).digest('hex') !== b.sha256 ||
        !verify(
          'sha256',
          file,
          { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
          Buffer.from(b.signature, 'base64'),
        )
      )
        throw new ApiError(
          422,
          'INVALID_FIRMWARE_SIGNATURE',
          'The image hash or approved release signature is invalid.',
        );
      const path = `releases/${b.version}/${b.sha256}.bin`;
      const exists = await platformTx(
        pool,
        res.locals.actor.id,
        async (tx) =>
          (await tx.query('SELECT version FROM firmware_releases WHERE version=$1', [b.version]))
            .rowCount,
      );
      if (exists)
        throw new ApiError(
          409,
          'FIRMWARE_VERSION_EXISTS',
          'Publish a new version; signed release bytes are immutable.',
        );
      const uploaded = await storage.storage
        .from('firmware')
        .upload(path, file, { contentType: 'application/octet-stream', upsert: false });
      if (uploaded.error)
        throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Firmware storage is unavailable.');
      await platformTx(pool, res.locals.actor.id, (tx) =>
        tx.query(
          'INSERT INTO firmware_releases(version,channel,sha256,signature,size,security_version,hardware_model,storage_path,pipeline_ref,published_by,signing_key_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
          [
            b.version,
            b.channel,
            b.sha256,
            b.signature,
            file.length,
            b.security_version,
            b.hardware_model,
            path,
            b.pipeline_ref,
            res.locals.actor.id,
            firmwareKeyId(publicKey),
          ],
        ),
      );
      res.status(201).json({ version: b.version, enabled: false });
    }),
  );
  r.patch(
    '/firmware-releases/:version',
    asyncRoute(async (req, res) => {
      const v = version.parse(req.params.version),
        b = firmwareApprovalSchema.parse(req.body);
      if (!publicKey && b.enabled)
        throw new ApiError(
          503,
          'FIRMWARE_SIGNING_UNCONFIGURED',
          'Configure the approved release public key first.',
        );
      await platformTx(pool, res.locals.actor.id, async (tx) => {
        if (b.enabled) {
          const signed = (
            await tx.query(
              'SELECT signing_key_fingerprint FROM firmware_releases WHERE version=$1',
              [v],
            )
          ).rows[0];
          if (signed?.signing_key_fingerprint !== firmwareKeyId(publicKey))
            throw new ApiError(
              409,
              'FIRMWARE_KEY_CHANGED',
              'Reverify the release under the approved signing-key rotation process.',
            );
        }
        const row = await tx.query(
          'UPDATE firmware_releases SET enabled=$2,pipeline_ref=pipeline_ref||$3 WHERE version=$1 RETURNING version',
          [v, b.enabled, `\nApproval ${b.acceptance_ref}: ${b.reason}`],
        );
        if (!row.rowCount) throw notFound();
      });
      res.status(204).end();
    }),
  );
  r.patch(
    '/devices/:id/hardware',
    asyncRoute(async (req, res) => {
      const id = uuid.parse(req.params.id),
        b = hardwareVerificationSchema.parse(req.body);
      await platformTx(pool, res.locals.actor.id, async (tx) => {
        const row = await tx.query(
          'UPDATE devices SET hardware_model=$2,verified_chip_revision=$3,verified_flash_bytes=$4,hardware_verified_by=$5,hardware_verified_at=now(),hardware_verification_ref=$6 WHERE id=$1 RETURNING id',
          [
            id,
            b.hardware_model,
            b.chip_revision,
            b.flash_bytes,
            res.locals.actor.id,
            b.verification_ref,
          ],
        );
        if (!row.rowCount) throw notFound();
      });
      res.status(204).end();
    }),
  );
  r.post(
    '/devices/:id/ota',
    asyncRoute(async (req, res) => {
      const id = uuid.parse(req.params.id),
        b = firmwareAssignmentSchema.parse(req.body);
      await platformTx(pool, res.locals.actor.id, async (tx) => {
        const device = (await tx.query('SELECT * FROM devices WHERE id=$1 FOR UPDATE', [id]))
          .rows[0];
        if (!device) throw notFound();
        const release = (
          await tx.query('SELECT * FROM firmware_releases WHERE version=$1 FOR SHARE', [b.version])
        ).rows[0];
        if (
          b.enabled &&
          (!publicKey ||
            release?.signing_key_fingerprint !== firmwareKeyId(publicKey) ||
            !release?.enabled ||
            !device.hardware_verified_at ||
            device.hardware_model !== release.hardware_model ||
            device.status !== 'ACTIVE' ||
            device.verified_chip_revision < 300 ||
            device.verified_flash_bytes !== 4194304)
        )
          throw new ApiError(
            409,
            'OTA_NOT_APPROVED',
            'Verify the physical hardware and enable an accepted signed release before assignment.',
          );
        await tx.query(
          'UPDATE device_ota_assignments SET enabled=false WHERE device_id=$1 AND enabled',
          [id],
        );
        if (b.enabled)
          await tx.query(
            'INSERT INTO device_ota_assignments(school_id,device_id,version,approved_by,reason,acceptance_ref) VALUES($1,$2,$3,$4,$5,$6)',
            [device.school_id, id, b.version, res.locals.actor.id, b.reason, b.acceptance_ref],
          );
      });
      res.status(204).end();
    }),
  );
  return r;
}
