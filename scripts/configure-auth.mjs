import { config } from 'dotenv';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { buildAuthConfig } from './lib/auth-config.mjs';
config({ path: '.env.auth', quiet: true });
const token = process.env.SUPABASE_ACCESS_TOKEN;
const project = process.env.SUPABASE_PROJECT_REF;
if (!token || !/^[a-z0-9]{8,40}$/.test(project || '')) {
  console.error(
    'Set SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF in your private .env.auth file. Do not use a browser key or commit this file.',
  );
  process.exitCode = 1;
} else {
  try {
    const endpoint = `https://api.supabase.com/v1/projects/${project}/config/auth`;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const read = await fetch(endpoint, { headers, signal: AbortSignal.timeout(20000) });
    if (!read.ok) throw new Error(`Auth configuration read failed (HTTP ${read.status}).`);
    const current = await read.json();
    const desired = buildAuthConfig(
      current,
      process.env.AUTH_SITE_URL,
      process.env.AUTH_PASSWORD_MIN_LENGTH,
    );
    // Never print or back up provider/SMTP secrets returned by Management API.
    console.log('Project:', project, '| Site URL:', desired.site_url);
    console.log(
      'Plan: 8 branded templates, verified email changes, password security, and exact callback URLs.',
    );
    console.log('Custom SMTP configured:', Boolean(current.smtp_host && current.smtp_user));
    console.log('Project minimum password length:', desired.password_min_length);
    if (!process.argv.includes('--apply'))
      console.log(
        'Read-only preview. Run with --apply after deploying the new frontend callback and database migration.',
      );
    else {
      await mkdir('output', { recursive: true });
      const backup = {
        project_ref: project,
        settings: Object.fromEntries(
          Object.keys(desired)
            .filter((key) => current[key] !== undefined)
            .map((key) => [key, current[key]]),
        ),
      };
      try {
        await writeFile('output/auth-config-backup.json', JSON.stringify(backup, null, 2), {
          mode: 0o600,
          flag: 'wx',
        });
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = JSON.parse(await readFile('output/auth-config-backup.json', 'utf8'));
        if (existing.project_ref !== project)
          throw new Error(
            'Existing Auth backup belongs to another project. Preserve it separately before configuring this project.',
          );
        console.log('Preserving the original configuration backup.');
      }
      const response = await fetch(endpoint, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(desired),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok)
        throw new Error(`Auth configuration update failed (HTTP ${response.status}).`);
      const check = await fetch(endpoint, { headers, signal: AbortSignal.timeout(20000) });
      if (!check.ok)
        throw new Error(
          'Settings were submitted but read-back verification failed. Check the Auth dashboard.',
        );
      const actual = await check.json();
      if (Object.entries(desired).some(([key, value]) => actual[key] !== value))
        throw new Error(
          'Settings were submitted but do not all match on read-back. Check the Auth dashboard.',
        );
      console.log(
        'Auth templates and security settings applied and verified. SMTP and Google credentials were preserved.',
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Auth configuration failed.');
    process.exitCode = 1;
  }
}
