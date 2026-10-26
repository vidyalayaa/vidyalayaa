import { it, expect } from 'vitest';
// Deployment tooling is plain JavaScript and shares no runtime credentials.
// @ts-expect-error Node deployment module has no separate declaration file.
import { authEmails, emailConfig, renderAuthEmail } from '../../scripts/lib/auth-emails.mjs';
// @ts-expect-error Node deployment module has no separate declaration file.
import { buildAuthConfig } from '../../scripts/lib/auth-config.mjs';

it('creates all six auth templates and two security notifications without external assets or unsafe metadata', () => {
  expect(authEmails.map((x: { key: string }) => x.key)).toEqual([
    'confirmation',
    'invite',
    'magic_link',
    'email_change',
    'recovery',
    'reauthentication',
    'password_changed_notification',
    'email_changed_notification',
  ]);
  for (const item of authEmails) {
    const html = renderAuthEmail(item);
    expect(html).toContain('vidyalayaa.');
    expect(html).toContain('#c7f55b');
    expect(html).not.toMatch(/<script|<form|https?:\/\/.*\.(png|jpg)|\.Data/);
    if (item.type)
      expect(html).toContain(`/auth/verify#token_hash={{ .TokenHash }}&amp;type=${item.type}`);
    if (item.code) expect(html).toContain('{{ .Token }}');
  }
  expect(emailConfig().mailer_templates_reauthentication_content).not.toContain('token_hash=');
});
it('enforces provider security without changing SMTP, Google, or enabling public signup', () => {
  const result = buildAuthConfig({
    site_url: 'https://school.example',
    uri_allow_list: 'https://school.example/auth/google/callback',
    password_min_length: 16,
    mailer_otp_exp: 3600,
    smtp_pass: 'private',
    external_google_secret: 'private',
  });
  expect(result).toMatchObject({
    password_min_length: 16,
    mailer_otp_exp: 1800,
    mailer_secure_email_change_enabled: true,
    mailer_autoconfirm: false,
    security_update_password_require_current_password: true,
    security_update_password_require_reauthentication: true,
  });
  expect(result.uri_allow_list).toContain('/auth/verify');
  expect(result).not.toHaveProperty('smtp_pass');
  expect(result).not.toHaveProperty('external_google_secret');
  expect(result).not.toHaveProperty('disable_signup');
  expect(() => buildAuthConfig({}, 'http://school.example')).toThrow();
  expect(() => buildAuthConfig({}, 'https://user:password@school.example')).toThrow();
  expect(() => buildAuthConfig({}, 'https://school.example/untrusted')).toThrow();
});
