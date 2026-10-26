import { mkdir, writeFile } from 'node:fs/promises';
import { authEmails, renderAuthEmail } from './lib/auth-emails.mjs';
await mkdir('supabase/templates', { recursive: true });
for (const email of authEmails)
  await writeFile(`supabase/templates/${email.key}.html`, renderAuthEmail(email));
console.log(`Generated ${authEmails.length} branded Auth email templates.`);
