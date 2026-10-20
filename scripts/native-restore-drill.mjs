import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { encryptBackup, decryptBackup } from './lib/backup-crypto.ts';
const run = promisify(execFile),
  name = process.argv[2];
if (!/^vidyalayaa-audit-[a-f0-9]{12}$/.test(name || ''))
  throw new Error('ONLY_A_DISPOSABLE_AUDIT_CONTAINER_IS_ALLOWED');
const inspected = JSON.parse(
  (await run('docker', ['inspect', name], { windowsHide: true })).stdout,
)[0];
if (inspected.Config.Labels['vidyalayaa.purpose'] !== 'isolated-audit-test')
  throw new Error('WRONG_CONTAINER_PURPOSE');
const root = resolve('tmp/restore-drill'),
  path = join(root, randomUUID() + '.vbackup'),
  plaintext = path + '.dump',
  key = randomBytes(32).toString('hex');
await mkdir(root, { recursive: true });
const started = Date.now();
const docker = async (args) =>
  (await run('docker', ['exec', name, ...args], { windowsHide: true })).stdout;
const counts =
  "SELECT json_build_object('events',(SELECT count(*) FROM attendance_events),'days',(SELECT count(*) FROM daily_attendance),'students',(SELECT count(*) FROM students),'identities',(SELECT count(*) FROM auth.users),'outbox',(SELECT count(*) FROM notification_outbox),'event_hash',(SELECT md5(string_agg(device_event_id::text,'|' ORDER BY device_event_id)) FROM attendance_events))";
try {
  const before = JSON.parse(
    await docker(['psql', '-U', 'postgres', '-d', 'vidyalayaa_test', '-Atc', counts]),
  );
  const dump = spawn(
    'docker',
    [
      'exec',
      name,
      'pg_dump',
      '-U',
      'postgres',
      '-d',
      'vidyalayaa_test',
      '--format=custom',
      '--compress=0',
      '--no-owner',
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  dump.stderr.resume();
  const done = new Promise((ok, fail) => {
    dump.once('error', fail);
    dump.once('exit', (code) => (code === 0 ? ok() : fail(new Error('DUMP_FAILED'))));
  });
  const [encrypted, processResult] = await Promise.allSettled([
    encryptBackup(dump.stdout, path, key),
    done,
  ]);
  if (encrypted.status === 'rejected') throw encrypted.reason;
  if (processResult.status === 'rejected') throw processResult.reason;
  await decryptBackup(path, plaintext, key);
  await docker(['createdb', '-U', 'postgres', 'vidyalayaa_restore_test']);
  await run('docker', ['cp', plaintext, name + ':/tmp/restore.dump'], { windowsHide: true });
  await docker([
    'pg_restore',
    '-U',
    'postgres',
    '--dbname=vidyalayaa_restore_test',
    '--no-owner',
    '--clean',
    '--if-exists',
    '--exit-on-error',
    '/tmp/restore.dump',
  ]);
  const after = JSON.parse(
    await docker(['psql', '-U', 'postgres', '-d', 'vidyalayaa_restore_test', '-Atc', counts]),
  );
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('RESTORED_RECORDS_DIFFER');
  await run('docker', ['cp', resolve('db/tests/verify.sql'), name + ':/tmp/verify.sql'], {
    windowsHide: true,
  });
  await docker([
    'psql',
    '-U',
    'postgres',
    '-d',
    'vidyalayaa_restore_test',
    '-v',
    'ON_ERROR_STOP=1',
    '-f',
    '/tmp/verify.sql',
  ]);
  const evidence = {
    at: new Date().toISOString(),
    engine: inspected.Config.Image,
    encryption: 'AES-256-GCM/HKDF-SHA256',
    ...encrypted.value,
    matched_counts: after,
    schema_security_verified: true,
    elapsed_ms: Date.now() - started,
    scope:
      'Generated local fixture database only. No cloud Auth/provider/object-storage or operational RPO/RTO acceptance.',
  };
  await writeFile(
    resolve('output/native-restore-evidence.json'),
    JSON.stringify(evidence, null, 2) + '\n',
  );
  console.info(
    `Native encrypted restore passed in ${evidence.elapsed_ms} ms; schema security, identities and event hashes match.`,
  );
} finally {
  await rm(plaintext, { force: true });
  await rm(path, { force: true });
}
