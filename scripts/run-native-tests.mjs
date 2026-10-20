import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
const name = 'vidyalayaa-audit-' + randomBytes(6).toString('hex'),
  password = randomBytes(32).toString('hex');
function command(bin, args, env = process.env, capture = false) {
  return new Promise((ok, fail) => {
    const p = spawn(bin, args, {
      env,
      windowsHide: true,
      stdio: ['ignore', capture ? 'pipe' : 'inherit', 'pipe'],
    });
    let output = '';
    p.stdout?.on('data', (b) => (output += b));
    p.stderr.on('data', (b) => {
      if (capture) output += b;
      else process.stderr.write(b);
    });
    p.once('error', fail);
    p.once('exit', (code) =>
      code === 0 ? ok(output) : fail(new Error(`${bin} exited with ${code}`)),
    );
  });
}
let created = false;
try {
  await command(
    'docker',
    [
      'run',
      '--detach',
      '--rm',
      '--name',
      name,
      '--label',
      'vidyalayaa.purpose=isolated-audit-test',
      '--publish',
      '127.0.0.1::5432',
      '--tmpfs',
      '/var/lib/postgresql/data:rw',
      '--env',
      'POSTGRES_PASSWORD',
      '--env',
      'POSTGRES_DB=vidyalayaa_test',
      'postgres:17',
    ],
    { ...process.env, POSTGRES_PASSWORD: password },
    true,
  );
  created = true;
  const binding = JSON.parse(await command('docker', ['inspect', name], process.env, true))[0]
    .NetworkSettings.Ports['5432/tcp'][0];
  const url = `postgresql://postgres:${password}@127.0.0.1:${binding.HostPort}/vidyalayaa_test`;
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    TEST_DATABASE_URL: url,
    MIGRATION_DATABASE_URL: url,
    DB_SSL: 'false',
    CONCURRENCY_ITERATIONS: process.env.CONCURRENCY_ITERATIONS || '1000',
  };
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      await command(
        'docker',
        [
          'exec',
          name,
          'pg_isready',
          '--host=127.0.0.1',
          '--username=postgres',
          '--dbname=vidyalayaa_test',
        ],
        process.env,
        true,
      );
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!ready) throw new Error('ISOLATED_POSTGRES_NOT_READY');
  console.info(
    'Disposable PostgreSQL ready; no application credentials or connected database are used.',
  );
  for (const script of ['scripts/prepare-test-db.ts', 'scripts/migrate.ts'])
    await command(process.execPath, ['node_modules/tsx/dist/cli.mjs', script], env);
  await command(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'scripts/migrate.ts', '--verify'],
    env,
  );
  const fixtures = process.argv.includes('--fixtures');
  await command(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      fixtures ? 'vitest.native.config.ts' : 'vitest.integration.config.ts',
      ...process.argv.slice(2).filter((x) => x !== '--fixtures'),
    ],
    fixtures ? { ...env, NATIVE_FIXTURE_DATABASE_URL: url } : env,
  );
  if (!fixtures) await command(process.execPath, ['scripts/native-restore-drill.mjs', name], env);
} finally {
  // Only the unique container created by this invocation can be stopped/removed.
  if (created) await command('docker', ['stop', '--time', '5', name], process.env, true);
}
