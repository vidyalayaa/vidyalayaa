export const authEmails = [
  {
    key: 'confirmation',
    subject: 'Confirm your email | Vidyalayaa',
    title: 'A connected school starts here.',
    description: 'Confirm your email address to finish verifying your Vidyalayaa account.',
    button: 'Confirm email address',
    type: 'signup',
  },
  {
    key: 'invite',
    subject: 'You’re invited to Vidyalayaa',
    title: 'Your school is ready to connect.',
    description:
      'You have been invited to Vidyalayaa. Verify this address and choose your password, then review and accept your school invitation inside the website.',
    button: 'Complete account setup',
    type: 'invite',
  },
  {
    key: 'magic_link',
    subject: 'Your secure sign-in | Vidyalayaa',
    title: 'Welcome back to your school day.',
    description:
      'Use the secure link below to sign in. If you were invited to a school, review your pending invitation after signing in. You can also enter the one-time code on the sign-in page.',
    button: 'Continue to sign in',
    type: 'email',
    code: true,
  },
  {
    key: 'email_change',
    subject: 'Confirm your email change | Vidyalayaa',
    title: 'Let’s confirm your new address.',
    description:
      'An email change was requested for your account. Confirm this change only if you requested it. With secure email change enabled, you must confirm the messages sent to both addresses.',
    button: 'Review email change',
    type: 'email_change',
    addresses: true,
  },
  {
    key: 'recovery',
    subject: 'Choose your password | Vidyalayaa',
    title: 'A fresh start. The same account.',
    description:
      'A password setup or reset was requested for your Vidyalayaa account. Use this secure link to choose your password. Adding a password keeps your existing Google sign-in connected.',
    button: 'Choose a new password',
    type: 'recovery',
  },
  {
    key: 'reauthentication',
    subject: 'Verify your identity | Vidyalayaa',
    title: 'A little extra protection.',
    description:
      'Enter this one-time verification code in Vidyalayaa to confirm a sensitive account change. Keep this code private.',
    code: true,
  },
  {
    key: 'password_changed_notification',
    notification: 'password_changed',
    subject: 'Your password was changed | Vidyalayaa',
    title: 'Your password has been updated.',
    description:
      'The password for your Vidyalayaa account was changed. If this wasn’t you, request a password reset immediately and review your active login sessions.',
  },
  {
    key: 'email_changed_notification',
    notification: 'email_changed',
    subject: 'Your email was changed | Vidyalayaa',
    title: 'Your account email has changed.',
    description:
      'Your account email was changed from {{ .OldEmail }} to {{ .Email }}. If you did not authorize this, contact Vidyalayaa support immediately.',
  },
];

export function renderAuthEmail(email) {
  const action = email.type
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:28px 0"><tr><td style="border-radius:12px;background:#c7f55b"><a href="{{ .SiteURL }}/auth/verify#token_hash={{ .TokenHash }}&amp;type=${email.type}" style="display:inline-block;padding:16px 24px;color:#171b16;font-size:15px;font-weight:bold;text-decoration:none">${email.button} &rarr;</a></td></tr></table><p style="font-size:13px;line-height:1.7;color:#59674f">This link is time-limited and can be used once. You will be asked to confirm the action on the website before it is completed.</p>`
    : '';
  const code = email.code
    ? '<p style="font-size:13px;color:#59674f;margin-top:24px">Your one-time verification code</p><p style="font-size:30px;font-weight:bold;letter-spacing:6px;padding:18px;background:#f1f6e7;border:1px solid #dfe7d3;border-radius:12px;text-align:center">{{ .Token }}</p>'
    : '';
  const address = email.addresses
    ? '<p style="padding:16px;background:#f1f6e7;border-radius:12px;font-size:14px;line-height:1.8">Current address: {{ .Email }}<br>Requested address: {{ .NewEmail }}</p>'
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${email.subject}</title></head>
<body style="margin:0;padding:0;background:#f6f7f3;color:#171b16;font-family:'Fabric Grotesk',Arial,Helvetica,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${email.title} Your school. Your people. In sync.</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f7f3"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid #e1e5d9;border-radius:20px;overflow:hidden">
<tr><td style="padding:30px 32px;border-bottom:1px solid #e9ebe5"><span style="display:inline-block;background:#c7f55b;border-radius:10px;padding:5px 10px;font-size:27px;font-weight:bold;color:#171b16">v.</span><span style="padding-left:10px;font-size:26px;font-weight:bold;letter-spacing:-1px">vidyalayaa.</span></td></tr>
<tr><td style="padding:32px"><p style="font-size:10px;letter-spacing:2px;color:#526044;font-weight:bold">YOUR SCHOOL, IN SYNC</p><h1 style="font-size:28px;line-height:1.2;letter-spacing:-1px;margin:18px 0">${email.title}</h1><p style="font-size:15px;line-height:1.8;color:#59674f">${email.description}</p>${address}${code}${action}<p style="font-size:12px;line-height:1.8;color:#59674f;margin-top:26px">If you didn’t request this, do not share this message or its codes. You can ignore unrequested setup and verification messages. Vidyalayaa will never ask you to send us your password or verification code.</p></td></tr>
<tr><td style="padding:22px 32px;background:#eff5e3;border-top:1px solid #e1e5d9"><p style="font-size:13px;font-weight:bold;margin:0">A connected school. A calmer day.</p><p style="font-size:12px;margin:10px 0 0"><a href="mailto:vidyalayaainfo@gmail.com" style="color:#3c581d;text-decoration:underline">Contact Vidyalayaa</a></p></td></tr></table>
<p style="font-size:11px;line-height:1.7;color:#67745a;margin:22px 0">Account email for {{ .Email }}<br>School access is assigned by your school. Verifying an email does not grant a school role.</p>
</td></tr></table></body></html>\n`;
}

export function emailConfig() {
  return Object.fromEntries(
    authEmails.flatMap((email) => [
      [`mailer_subjects_${email.key}`, email.subject],
      [`mailer_templates_${email.key}_content`, renderAuthEmail(email)],
      ...(email.notification ? [[`mailer_notifications_${email.notification}_enabled`, true]] : []),
    ]),
  );
}
