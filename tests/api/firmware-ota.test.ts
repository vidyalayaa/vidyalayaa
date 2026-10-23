import { fixtureBearer, withProviderSessions } from '../helpers/provider-sessions.js';
import { beforeAll, afterAll, it, expect } from 'vitest';
import request from 'supertest';
import { generateKeyPairSync, sign, createHash, constants } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { portableDatabase, poolAdapters, fixture } from '../helpers/database.js';
import { createApp } from '../../apps/api/src/app.js';
import type { Config } from '../../apps/api/src/lib/config.js';
import { hash } from '../../apps/api/src/lib/crypto.js';
import { transaction } from '../../apps/api/src/lib/db.js';
import { deviceOtaOffer } from '../../apps/api/src/modules/devices/ota.js';
let db: PGlite,
  pools: ReturnType<typeof poolAdapters>,
  f: Awaited<ReturnType<typeof fixture>>,
  app: ReturnType<typeof createApp>,
  root: string,
  token: string,
  code: string;
const keys = generateKeyPairSync('rsa', { modulusLength: 3072 }),
  publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
// Signed transport fixture only. This buffer is deliberately not a bootable firmware image.
const image = Buffer.alloc(2048, 0);
image[0] = 0xe9;
const manifest = {
  version: '1.1.0',
  channel: 'PILOT',
  hardware_model: 'ESP32_ECO3_4MB',
  security_version: 1,
  sha256: createHash('sha256').update(image).digest('hex'),
  signature: sign('sha256', image, {
    key: keys.privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  }).toString('base64'),
  pipeline_ref: 'isolated-transport-verification',
};
const objects = new Map<string, Buffer>();
beforeAll(async () => {
  db = await portableDatabase();
  pools = poolAdapters(db);
  f = await fixture(db);
  root = crypto.randomUUID();
  await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [
    root,
    'release@example.invalid',
  ]);
  await db.query("INSERT INTO platform_staff(user_id,platform_role) VALUES($1,'SUPER_ADMIN')", [
    root,
  ]);
  token = 'test.' + Buffer.from(JSON.stringify({ aal: 'aal2' })).toString('base64url') + '.fixture';
  code = (
    await db.query<{ device_code: string }>('SELECT device_code FROM devices WHERE id=$1', [
      f.deviceA,
    ])
  ).rows[0].device_code;
  await db.query(
    "INSERT INTO device_credentials(school_id,device_id,secret_hash,status) VALUES($1,$2,$3,'ACTIVE')",
    [f.schoolA, f.deviceA, Buffer.from(hash('reader-fixture-secret'), 'hex')],
  );
  const supabase = {
    auth: {
      getUser: async (t: string) => ({
        data: { user: { id: t === token ? root : f.admin } },
        error: null,
      }),
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, bytes: Buffer) => {
          objects.set(bucket + '/' + path, bytes);
          return { error: null };
        },
        download: async (path: string) => ({
          error: null,
          data: new Blob([new Uint8Array(objects.get(bucket + '/' + path) || [])]),
        }),
      }),
    },
  } as unknown as SupabaseClient;
  app = createApp(
    {
      NODE_ENV: 'test',
      PORT: 4000,
      WEB_ORIGINS: 'http://localhost:5173',
      TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
      TRUST_PROXY_HOPS: 0,
      FIRMWARE_RELEASE_PUBLIC_KEY: publicKey,
    } as Config,
    { ...pools, supabase: withProviderSessions(db, supabase) },
  );
});
afterAll(async () => db.close());
const platform = (method: 'get' | 'post' | 'patch', path: string, t = token) =>
  request(app)
    [method]('/api/v1/platform' + path)
    .set('Authorization', 'Bearer ' + fixtureBearer(t));
it('rejects school-side publication and invalid release signatures', async () => {
  expect((await platform('get', '/firmware-releases', 'admin')).status).toBe(403);
  const bad = { ...manifest, signature: 'A'.repeat(512) };
  const result = await platform('post', '/firmware-releases')
    .field('manifest', JSON.stringify(bad))
    .attach('image', image, 'test.bin');
  expect(result.status).toBe(422);
  expect(objects.size).toBe(0);
});
it('publishes immutable signed bytes disabled and audits the release', async () => {
  const result = await platform('post', '/firmware-releases')
    .field('manifest', JSON.stringify(manifest))
    .attach('image', image, 'test.bin');
  expect(result.status).toBe(201);
  expect(result.body.enabled).toBe(false);
  expect(
    (
      await platform('post', '/firmware-releases')
        .field('manifest', JSON.stringify(manifest))
        .attach('image', image, 'test.bin')
    ).status,
  ).toBe(409);
  expect(
    (await db.query("SELECT action FROM audit_logs WHERE action='firmware.release_changed'")).rows,
  ).toHaveLength(1);
});
it('requires verified physical hardware and accepted release before an offer', async () => {
  const assignment = {
    version: manifest.version,
    enabled: true,
    reason: 'Pilot acceptance verified on test fixture',
    acceptance_ref: 'fixture-acceptance-record',
  };
  expect((await platform('post', `/devices/${f.deviceA}/ota`).send(assignment)).status).toBe(409);
  expect(
    (
      await platform('patch', '/firmware-releases/1.1.0').send({
        enabled: true,
        reason: assignment.reason,
        acceptance_ref: assignment.acceptance_ref,
      })
    ).status,
  ).toBe(204);
  expect(
    (
      await platform('patch', `/devices/${f.deviceA}/hardware`).send({
        hardware_model: 'ESP32_ECO3_4MB',
        chip_revision: 300,
        flash_bytes: 4194304,
        verification_ref: 'isolated-hardware-fixture',
      })
    ).status,
  ).toBe(204);
  expect((await platform('post', `/devices/${f.deviceA}/ota`).send(assignment)).status).toBe(204);
  const offer = await transaction(
    pools.device,
    { schoolId: f.schoolA, actorType: 'DEVICE' },
    (tx) => deviceOtaOffer(tx, f.deviceA, publicKey),
  );
  expect(offer.available).toBe(true);
  const foreign = await transaction(
    pools.device,
    { schoolId: f.schoolB, actorType: 'DEVICE' },
    (tx) => deviceOtaOffer(tx, f.deviceA, publicKey),
  );
  expect(foreign.available).toBe(false);
  const noKey = await transaction(
    pools.device,
    { schoolId: f.schoolA, actorType: 'DEVICE' },
    (tx) => deviceOtaOffer(tx, f.deviceA),
  );
  expect(noKey.available).toBe(false);
});
it('serves assigned private bytes only to the authenticated reader and checks storage integrity', async () => {
  expect((await request(app).get('/api/v1/device/ota/image/1.1.0')).status).toBe(401);
  const get = () =>
    request(app)
      .get('/api/v1/device/ota/image/1.1.0')
      .set('X-Device-Id', code)
      .set('Authorization', 'Bearer reader-fixture-secret');
  expect((await get()).status).toBe(200);
  const path = 'firmware/releases/1.1.0/' + manifest.sha256 + '.bin';
  objects.set(path, Buffer.alloc(2048));
  expect((await get()).status).toBe(503);
  objects.set(path, image);
  expect(
    (
      await platform('post', `/devices/${f.deviceA}/ota`).send({
        version: '1.1.0',
        enabled: false,
        reason: 'Withdraw isolated pilot assignment',
        acceptance_ref: 'fixture-withdrawal-record',
      })
    ).status,
  ).toBe(204);
  expect((await get()).status).toBe(404);
});
