import { emailConfig } from './auth-emails.mjs';

export function buildAuthConfig(current, site, minimumPasswordLength) {
  const passwordLength = minimumPasswordLength || '12';
  if (!/^(1[2-9]|[2-5][0-9]|6[0-4])$/.test(passwordLength))
    throw new Error('AUTH_PASSWORD_MIN_LENGTH must be a whole number from 12 to 64.');
  const url = new URL(site || current.site_url);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(['localhost', '127.0.0.1'].includes(url.hostname) && url.protocol === 'http:'))
  )
    throw new Error(
      'AUTH_SITE_URL must be a trusted HTTPS origin (HTTP is only allowed for local development).',
    );
  const redirects = new Set(
    String(current.uri_allow_list || '')
      .split(',')
      .filter(Boolean),
  );
  for (const path of ['/auth/verify', '/auth/callback', '/auth/google/callback'])
    redirects.add(url.origin + path);
  return {
    ...emailConfig(),
    site_url: url.origin,
    uri_allow_list: [...redirects].join(','),
    mailer_autoconfirm: false,
    mailer_allow_unverified_email_sign_ins: false,
    mailer_secure_email_change_enabled: true,
    security_update_password_require_reauthentication: true,
    security_update_password_require_current_password: true,
    password_min_length: Math.max(Number(passwordLength), current.password_min_length || 0),
    mailer_otp_exp: Math.min(1800, current.mailer_otp_exp || 1800),
  };
}
