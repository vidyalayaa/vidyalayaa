import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
const findings = [];
async function scan(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (
      [
        'node_modules',
        '.git',
        '.tools',
        'backups',
        'secrets',
        'tmp',
        'test-results',
        'playwright-report',
        '.pio',
      ].includes(e.name)
    )
      continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      await scan(path);
      continue;
    }
    if (e.name.startsWith('.env') && !e.name.endsWith('.example')) continue;
    if (!/\.(ts|tsx|js|mjs|json|sql|cpp|h|yml|yaml|html)$/.test(e.name)) continue;
    const text = await readFile(path, 'utf8');
    if (/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) findings.push(path);
    if (/sb_secret_[A-Za-z0-9_-]{20,}/.test(text)) findings.push(path);
    for (const jwt of text.matchAll(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g)) {
      try {
        const claims = JSON.parse(Buffer.from(jwt[0].split('.')[1], 'base64url').toString());
        if (claims.role === 'service_role') findings.push(path);
      } catch {}
    }
  }
}
await scan('.');
if (findings.length) {
  console.error('Potential secrets found in:', [...new Set(findings)]);
  process.exit(1);
}
console.info(
  'No private keys or embedded service-role JWTs found. Run gitleaks in CI for broader/history scanning.',
);
