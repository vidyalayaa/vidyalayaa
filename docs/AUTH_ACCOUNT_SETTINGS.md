# Authentication, account settings, and branded emails

## Implemented flows

| Feature                       | Entry point                                                                                    | Enforcement                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Invite a new account          | Existing Members & Invitations, record invitation actions, or platform School Admin onboarding | Existing permission checks, school/record binding and verified recipient acceptance; Supabase `inviteUserByEmail`         |
| Invite an existing account    | The same invitation actions                                                                    | Supabase `signInWithOtp`, with `shouldCreateUser: false`; recipient still separately accepts the school invitation        |
| Change email                  | Settings → Account security → Email & password                                                 | Current authenticated identity, provider MFA where enrolled, and provider confirmations at both addresses                 |
| Set a Google account password | Email & password → Send password setup link                                                    | Recovery link sent only to the verified account email; existing user ID and Google identity retained                      |
| Change a password             | Email & password → Change password                                                             | Provider validates current password and requests email reauthentication for older sessions; enrolled MFA remains required |
| Forgot password               | Login → Forgot password, or account settings reset-link action                                 | Provider-issued, time-limited recovery proof; no administrator password reset endpoint                                    |
| Email link / OTP sign-in      | Login → Sign in with an email link or code                                                     | Existing accounts only; successful sign-in still checks the existing authenticator flow                                   |
| Confirm an email action       | `/auth/verify`                                                                                 | Explicit confirmation click, single-use provider verification and verified account identity                               |

`/auth/callback` continues to support existing invitation and recovery emails and
PKCE links. `/auth/google/callback` keeps its existing Google-only behavior.
School members reach `/admin/settings/account`, `/principal/settings/account`,
`/teacher/settings/account`, `/parent/settings/account` or
`/student/settings/account`. Super Admin and unassigned users can use
`/settings/account`. Account-security settings also link to the page.

## Production readiness and required external configuration

Repository code and local Supabase templates are provided. **Hosted Auth template
installation, SMTP delivery and real inbox verification require access to the
Supabase project configuration.** A database/service-role credential cannot
replace a Supabase Management API access token. Do not report real email delivery
as verified merely because a test fixture or provider request returned success.

Deploy the website's new `/auth/verify` route before activating the new hosted
templates. Otherwise emailed links would point to a route the live website does
not yet have. Existing hosted templates and SMTP credentials are not changed by
building the repository or running database migrations.

## Deployment order

Use the supported Node.js version from `.nvmrc` and the existing deployment
credentials. From the repository root:

```sh
npm ci
npm run auth:emails
npm run build -w @vidyalayaa/contracts
npm run db:migrate
npm run db:verify
npm run contracts
npm run build
```

Deploy `apps/web/dist` to the existing Firebase project first, so the new
verification callback exists before any new email points to it:

```sh
firebase deploy --only hosting
```

Next install the hosted Auth configuration below (including its callback
allowlist), then deploy the updated API to the existing Render API service
using its normal deployment process. Use a maintenance window for this rollout:
the new account settings endpoint becomes available when the API deployment
finishes. Existing invitation and recovery callbacks remain compatible.

The worker's deployment and Resend/FCM configuration are unchanged. Account
verification mail is delivered by Supabase Auth through its configured SMTP
provider; it does not depend on the worker running.

## Hosted configuration tool

Copy `.env.auth.example` to `.env.auth`. This private file and the configuration
backup are ignored by Git. Fill in:

| Variable                | Purpose                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_PROJECT_REF`  | The project reference matching the API and frontend                                                                             |
| `SUPABASE_ACCESS_TOKEN` | A Supabase account Management API token with permission to configure that project; never use a service-role or browser key here |
| `AUTH_SITE_URL`         | The website's trusted HTTPS origin, without a path, query or fragment                                                           |

Create the token in Supabase Account → Access tokens. Enter it only in your
private local environment. Do not paste it into chat, GitHub, or any `VITE_*`
variable. These are one-time deployment-tool variables, not frontend or worker
runtime variables.

First inspect the read-only plan, then apply it after frontend deployment and
before deploying the updated API's existing-account invitation delivery:

```sh
npm run auth:configure
npm run auth:configure -- --apply
```

The tool backs up only affected settings to `output/auth-config-backup.json`,
patches the configuration and reads it back to verify it. It never prints or
backs up SMTP passwords or Google client secrets. It installs six authentication
templates and two account-change notifications, adds exact callback URLs,
enforces email confirmation and double confirmation for email changes, requires
current password and provider reauthentication for password changes, preserves
any stronger minimum password length, and caps email OTP/link validity at 30
minutes. It preserves SMTP credentials, Google configuration, signup policy and
existing redirect URLs.

The backup records the project reference and original `settings` object. It is
not overwritten on subsequent runs; a backup from another project stops an
update rather than being replaced.

Do not raise or disable provider rate limits just to work around a failed test.
Configure legitimate provider capacity in the dashboard when needed.

## Manual Supabase dashboard equivalent

In Authentication → Email/Templates, paste the corresponding generated HTML and
subject from `scripts/lib/auth-emails.mjs`:

| Dashboard template            | HTML file                                               |
| ----------------------------- | ------------------------------------------------------- |
| Confirm sign up               | `supabase/templates/confirmation.html`                  |
| Invite user                   | `supabase/templates/invite.html`                        |
| Magic link / OTP              | `supabase/templates/magic_link.html`                    |
| Change email                  | `supabase/templates/email_change.html`                  |
| Reset password                | `supabase/templates/recovery.html`                      |
| Reauthentication              | `supabase/templates/reauthentication.html`              |
| Password changed notification | `supabase/templates/password_changed_notification.html` |
| Email changed notification    | `supabase/templates/email_changed_notification.html`    |

Enable the last two security notifications. Keep `TokenHash`, `Token`, `Email`,
`NewEmail` and `OldEmail` placeholders intact. Do not replace authentication
links with plain login-page links. Do not add analytics or click tracking to
these emails: rewriting or prefetching action links can break verification.

In Authentication → URL Configuration, set the Site URL to the actual deployed
website origin and allow these exact URLs for each trusted environment:

```text
https://YOUR_WEBSITE/auth/verify
https://YOUR_WEBSITE/auth/callback
https://YOUR_WEBSITE/auth/google/callback
```

Keep the first Render `WEB_ORIGINS` entry set to the deployed frontend origin;
the existing invitation workflow uses it as its provider redirect. Generated
custom emails use the configured Site URL and `/auth/verify`. For local work,
use a separate development project or local Supabase and the existing localhost
callback allowlist. Do not point a production Site URL at localhost.

Generated links carry their one-use proof in a URL fragment, which browsers do
not send to Hosting request logs. The callback immediately removes it from
browser history and consumes it only after an explicit confirmation click.
Older query-based and provider callback links remain supported.

In Authentication → Sign In / Providers → Email, enable:

- Confirm email; disable unverified-email sign-in and automatic confirmation.
- Secure email change / confirmations at both current and new addresses.
- Secure password change / require reauthentication.
- Require current password when changing an existing password.
- Minimum password length of at least 12; retain any stronger existing setting.
- A time-limited email OTP/link expiry of at most 1800 seconds.

These provider settings are essential: hiding a button or asking for a password
in the browser alone does not enforce security against direct API requests.
Provider-verified recovery flows and setting a first password have the provider's
appropriate exceptions to current-password validation.

## Existing SMTP infrastructure

Use Authentication → Email → SMTP Settings. Preserve the existing sender and
provider credentials. For the previously discussed Gmail setup, the connection
is `smtp.gmail.com`, port `465` with SSL/TLS, full Gmail address as the username,
and a Google App Password generated after enabling 2-Step Verification. Set the
sender address to the authorized mailbox and sender name to **Vidyalayaa**.
Store the App Password only in the Supabase SMTP configuration. Never disable
TLS verification or put SMTP credentials into frontend environment variables.

If custom SMTP is absent, Supabase's built-in mail restrictions may prevent
delivery to ordinary school recipients. Inspect Auth logs and the SMTP
provider's delivery logs; a frontend success message is not an inbox receipt.
Keep the existing school-notification Resend configuration separate.

## Database and ownership

`20261026033231_account_settings.sql` adds two narrow private functions:

- `app.account_credentials()` exposes only the server-validated caller's
  current email, pending email, email-confirmation flag and password-presence
  boolean. No target user ID is accepted. No password hash or Auth table is
  granted to browser, platform, worker or device roles. `app_api` can execute the
  function only through an authenticated request with the existing user context.
- `app.sync_verified_account_email()` mirrors only the provider's verified
  canonical email into `public.users`. It also repairs existing verified email
  drift during migration. User IDs, memberships, student/parent/staff links and
  school-owned contact records are preserved. Pending `auth.users.email_change`
  never replaces the application email before confirmation.

`GET /api/v1/account/credentials` is available to an authenticated account
without school selection. Query parameters and target-user IDs are rejected.
Passwords go directly to Supabase through its supported SDK. An isolated,
memory-only SDK client binds sensitive writes to the verified user's token, so
another tab switching accounts cannot redirect a pending write to someone else.
The browser does not save passwords, OTPs or reauthentication nonces as drafts.

The two private functions need narrowly scoped `SECURITY DEFINER` access because
Auth tables are deliberately unavailable to application roles. Both use fixed
search paths and explicit grants; the reader checks the existing server's
`app.user_id()` context and active account. No broad Auth-table grants are added.

The migration runner recognizes historical LF/CRLF checkout variants without
rewriting recorded migration checksums. Other content and whitespace edits still
fail validation. New migrations execute and hash the same canonical LF bytes.

## Automated checks

```sh
npm run typecheck
npx vitest run tests/api/account-settings.test.ts tests/api/invitations.test.ts tests/unit/auth-emails.test.ts tests/database/account-settings-upgrade.test.ts
npx playwright test tests/e2e/account-settings.spec.ts tests/e2e/auth-callback.spec.ts tests/e2e/google-login.spec.ts tests/e2e/onboarding.spec.ts tests/e2e/record-invitations.spec.ts --workers=1
npm run lint
npm run check:secrets
```

API tests use real isolated PostgreSQL via PGlite, with provider identities and
email calls simulated. Browser tests use the real SDK against intercepted test
provider endpoints. They exercise owned account settings for every role,
provider errors, current-password and reauthentication behavior, Google account
password creation, deferred email changes, expired/reused links, OTP sign-in,
MFA, account-switch rejection and existing invitation/recovery flows.

### Verification record — 26 October 2026

- Full isolated backend/database/unit suite: 285 tests passed. Subsequent focused
  checks passed 31 tests, including three new migration-checksum cases and the
  final invitation redirect/template changes. Counts overlap.
- Browser workflows: 88 cases passed across desktop and mobile: 30 account-settings
  cases, 18 legacy callback cases, and 40 Google/onboarding/record-invitation cases.
  The final 30-case account run includes URL-fragment proofs, default provider
  magic-link compatibility, ownership checks, and mobile overflow checks.
- Desktop and mobile account page screenshots were visually reviewed. Automated
  accessibility checks cover the new account page's main content; this does not
  certify the entire application.
- The additive account migration was applied to the configured database and
  schema verification passed. A read-only check through the actual restricted
  API database role verified the owned credential-presence function.
- Hosted Auth configuration/templates were **not** installed: no Management API
  token was available. The deployment helper and manual steps above are ready.
- The user chose to skip the live email test. No test emails were sent. Inbox
  delivery, real email confirmations and hosted provider policy enforcement
  remain unverified pending deployment/configuration and mailbox acceptance.

## Live acceptance checklist — external configuration required

Use dedicated test accounts and mailboxes you control; do not reset another
person's production password merely to test the system.

1. Invite a new test member from an authorized School Admin account. Verify an
   inbox receipt and the branded sender, open its link, confirm explicitly, set
   a password, accept the school invitation, and check the exact record/role.
2. Invite an existing test account to another school. Check that it receives a
   sign-in email and retains the previous school's role until separately
   accepting the new invitation. Force SMTP failure once and retry; there must
   be no reported sent mail or active membership on provider failure.
3. Request a password reset and follow its link. Verify that an expired or
   reused link fails even when another account is already signed in.
4. With a Google-only test account, request a password-setup link and add a
   password. Confirm both password login and Google login still return the same
   user ID, records and memberships.
5. Change an existing test password. Verify the wrong current password fails;
   if the session is old, request the reauthentication email and enter its code.
   Test an enrolled authenticator as well. Check the security notification.
6. Request an email change between two controlled mailboxes. After only one
   confirmation, the canonical address and application account email must stay
   unchanged. Confirm the other message, then check that account email changes,
   the account ID/records do not, and the notification is delivered.
7. Request a sign-in link/code, test valid and expired OTPs, and verify enrolled
   MFA remains required. Uninvited accounts must not gain school access.
8. Inspect Auth/SMTP delivery logs without copying tokens or email bodies into
   ordinary application logs. Check spam folders, provider quotas and bounce
   logs. The Auth and SMTP provider logs are the delivery evidence.

Real Google consent, hosted Auth policy enforcement, SMTP acceptance and inbox
delivery cannot be proved by the isolated tests alone. Record those acceptance
results separately after configuration and deployment.

## Troubleshooting and rollback

- Missing email: verify custom SMTP, approved sender, Auth rate limits and
  provider logs. Do not change the worker to fix Auth invitation delivery.
- Link opens localhost or the wrong site: correct the Site URL, callback
  allowlist and first `WEB_ORIGINS` origin, then request a fresh link.
- Password change asks for reauthentication: request the code from account
  settings, enter it and retry. A recovery link is available if the current
  password is forgotten.
- Email still shows the old address: confirm both inbox messages. Do not write
  the new address directly into `public.users` or a school profile.
- New credentials endpoint missing: deploy the API and apply the migration.
- Reused or lost verification link: request a fresh link. The page intentionally
  removes credentials from browser history; it never reuses an unrelated session.

For an application rollback, keep the additive database migration: the old
application still works with these functions and the canonical email trigger.
Restore the affected Auth settings/templates from
the `settings` object in `output/auth-config-backup.json` through the dashboard or Management API,
preserving SMTP/Google secrets. If intentionally removing the additive database
features, create a **new forward migration** using the Supabase CLI and drop
`auth_verified_email_changed` on `auth.users`, then
`app.sync_verified_account_email()` and `app.account_credentials()`. Do not edit
an applied migration or revert already verified account email changes.

## Provider references

- [Account updates](https://supabase.com/docs/reference/javascript/auth-updateuser)
- [Password security and reauthentication](https://supabase.com/docs/guides/auth/password-security)
- [Email templates and Management API](https://supabase.com/docs/guides/auth/auth-email-templates)
- [Identity linking and adding passwords to OAuth accounts](https://supabase.com/docs/guides/auth/auth-identity-linking)
