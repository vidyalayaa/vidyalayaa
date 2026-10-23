# Security & Login Sessions

Open **Settings → Security & Login Sessions**. Super Admin, School Admin, Principal, Teacher, Parent, Student and existing finance accounts use the same owner-only account controls. A selected school, subscription entitlement or school-management permission is not required.

## Available controls

- View all provider session rows belonging to the current account, including devices that have not opened the new page. The current session appears first and is labelled **Current Session**.
- View estimated device/browser, provider-recorded IP, login time and last activity. Unknown values are explicit. Dates use the viewer's device timezone. Browser tabs and installed web apps can share one browser session.
- End a selected session, including the current device, or log out all other devices while preserving the current session. Each operation requires confirmation.
- View recent new-login and session-control events. New-login emails use the existing Resend email delivery service when configured; login works without an email provider.
- Continue to use the existing authenticator setup and MFA sign-in requirements.

Device names are coarse labels derived from the provider's user agent and cannot prove device identity. IPs may identify a VPN, mobile network or shared gateway. No external IP lookup, browser fingerprint, precise geolocation, or untrusted forwarding/location header is used. Approximate location is currently **Not available**. Session timestamps are provider login/refresh times plus server-observed API activity, with activity writes throttled to once per minute. This measures application requests, not human interaction.

## Authentication and revocation

The application continues to use Supabase Auth for password, Google, invitation and MFA flows. Every authenticated user API request first calls `auth.getUser(token)`, then checks that the verified JWT's `session_id` belongs to that same active user in `auth.sessions`. Provider verification and the session-table check must both succeed. A missing/deleted/expired provider session is rejected; the session-table check returns `401 SESSION_ENDED`. An expired access token returns `401 UNAUTHENTICATED` and can refresh only while its provider session remains valid.

The session list is read directly from Supabase's provider-owned session table, through a narrowly scoped private database function. Metadata alone never creates authorization. Deleting optional activity metadata does not revoke or create a provider session.

Ending a session deletes the exact owned row in **`auth.sessions`**. This is the operation performed by Supabase Auth's `LogoutSession` / `LogoutAllExceptMe` implementation. The provider's `auth.refresh_tokens.session_id` foreign key cascades deletion of associated refresh tokens. Newer session refresh mechanisms also lose their session-owned keys. The migration checks that the expected cascading foreign key exists and stops if it does not. It does not create or alter provider tables, store another device's JWT, or impersonate another session to call logout.

The JavaScript SDK provides local/global/others sign-out scopes; it does not provide a session-ID-based administrative logout operation in the installed SDK. The private database function provides that operation without exposing provider credentials or broad table privileges. Ordinary browser sign-out explicitly uses `scope: 'local'`; the dedicated all-other-devices action preserves the current session.

Supabase JWTs are otherwise valid until token expiry. The added per-request database check prevents retained JWTs from accessing Vidyalayaa's API after revocation; requests already authorized before a concurrent logout may finish. Cached/downloaded data and previously issued short-lived signed file URLs cannot be recalled by session logout. Browser Auth cache is cleared on `SESSION_ENDED`; the application checks identity on focus and every minute while visible, and this security page refreshes sessions every 30 seconds.

`auth.sessions.not_after` is enforced immediately. Supabase's optional time-box, inactivity and single-session settings are provider-managed and enforced during refresh; this feature does not change those project settings or promise to infer unexposed timeout configuration. Expired access tokens still go through the existing refresh/sign-in flow when the provider session remains valid. See [Supabase sessions](https://supabase.com/docs/guides/auth/sessions), [sign-out scopes](https://supabase.com/docs/guides/auth/signout), and the [provider logout implementation](https://github.com/supabase/auth/blob/master/internal/models/sessions.go).

## Ownership and private data

- The API derives the account from the provider-verified identity. There is no user-ID selector or administrator impersonation endpoint.
- Session functions derive ownership from the existing transaction's `app.user_id`, validate a live current session, and scope every provider deletion to the owner. A foreign or unknown session ID returns the same 404 response.
- Private `app.login_session_activity` and `app.account_security_events` tables force RLS and have owner-only API read policies. Browser, school/platform administrators, device services and worker roles do not receive direct provider-table or credential access.
- The required `SECURITY DEFINER` helpers are in the non-exposed `app` schema with fixed search paths. Only the trusted API can observe/list/end sessions; only the worker can claim/finish email alerts and prune old events. `PUBLIC`, `anon`, and `authenticated` cannot execute these helpers.
- Responses omit raw user agents, passwords, factor secrets, access/refresh tokens and provider refresh keys. `/me` does not expose the internal current-session field.
- Security events are account-owned, not school-owned, so another school administrator or an approved school support grant cannot read a user's private session history.

## New-login alerts

A new verified provider session is observed when it first accesses Vidyalayaa's API. An account event is recorded once per session; automatic token refreshes do not create another alert. A failed password attempt or provider session that never accesses the app does not generate an application alert. Existing sessions are seeded during installation without new-login emails.

The existing background worker claims a small batch of account email events with leases and retry limits, then calls the existing email provider with a stable idempotency key. Recipient addresses come from the confirmed Supabase Auth user record, not request parameters. No password, token, IP or child information is included. Outbound email requires the existing `RESEND_API_KEY` and `EMAIL_FROM` worker secrets. Without them, the in-app alert remains available and no email is claimed. Transient failures retry; permanent or exhausted attempts stop. Emails older than 24 hours are not sent late. Account events expire after 90 days; optional activity metadata is removed when its provider session is deleted.

## API

All routes use the normal `Authorization: Bearer …` header and existing rate limits. They are mounted before school/subscription authorization. Do not copy tokens into support messages or logs.

| Method | Endpoint                                 | Response                                                                                     |
| ------ | ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/account/sessions`               | `{data: LoginSession[], events: AccountSecurityEvent[]}`                                     |
| DELETE | `/api/v1/account/sessions/{id}`          | `{ended: 1, current_session_ended: boolean}`; foreign/absent ID: 404                         |
| POST   | `/api/v1/account/sessions/logout-others` | `{ended: number, current_session_ended: false}`; retry with no remaining devices: `ended: 0` |

`LoginSession` includes `id`, `device`, `browser`, `ip_address`, nullable `location`, `login_at`, `last_active_at`, nullable `expires_at`, and `is_current`. The identifier is a session reference, not an authentication credential. Recent events are limited to 20 within the 90-day retention window.

## Deployment and recovery

1. Back up the existing database using the normal verified backup procedure.
2. Apply `db/migrations/20261023151112_login_sessions.sql` with the migration-owner connection **before** deploying the matching API. This installs private helpers and seeds optional activity for existing sessions without revoking them.
3. Run schema verification. Deploy the API, worker and website together through the existing deployment workflow.
4. Sign in from two separate browser profiles/devices and verify session labels, individual logout and logout of others. Ordinary tabs may share one session. Test on designated test accounts, not another person's sessions.

```powershell
npm run db:migrate
npm run db:verify
npm run contracts
npm run build
npx vitest run
npx playwright test tests/e2e/login-sessions.spec.ts --workers=1
```

If migration preflight rejects the provider schema, verify the connected project's Auth version and foreign keys against the current provider documentation; do not disable the check or create replacement Auth tables. If the API reports missing session helper functions, finish migration before starting the new API. If email is pending, verify the worker is running and its existing email secrets are configured.

Prefer forward fixes. Keep provider sessions intact during rollback. Never roll back by restoring removed refresh tokens or recreating ended sessions; sign in again to create fresh credentials. No firmware, attendance, fee, academics or school data migration is needed for this feature.

## Test scope

Tests use disposable PostgreSQL/PGlite databases with a minimal provider schema and explicitly simulated Auth/email services. API checks deliberately accept a retained token in the fake provider to prove that the application's real session-table check rejects it after deletion. They verify refresh-token cascade, ownership and administrator restrictions, all-role listing, current-session logout, logout of others, expiration, activity, deduplication, RLS and email retry behavior. Upgrade checks compare existing provider sessions, refresh credentials and school records before/after migration. Browser checks use the actual application/API/database policies with isolated provider fixtures on desktop and mobile. Real provider credentials and live email delivery require deployment smoke tests; no user device is terminated by automated verification.

### Verification record — 23 October 2026

- Final production build passed for contracts, API, worker and website. Lint (148 source files), the repository secret scan and whitespace checks passed. The existing mixed static/dynamic resource import warning remains non-blocking.
- Full regression run: 237 tests passed across 40 files. The additional migration preservation test also passed; the focused API/upgrade run passed all 11 tests after the final expiration distinction.
- Session browser checks: 16 passed in the main desktop/mobile run; the additional unassigned-account and valid-token-refresh cases passed in focused runs. Current-device sign-out, retained-token rejection, logout of others and all six requested roles were exercised, with accessibility and overflow checks.
- Existing MFA, Google and invitation/password callback checks were executed. The account-without-membership redirect was restored to the existing school-selection behavior, with a separate link to owned account security; affected cases passed on desktop/mobile rerun. One callback check interrupted by development-server hot reload passed on isolated rerun. Across full/focused runs, all 54 distinct existing authentication cases passed.
- Connected database migration installed and schema verification passed. Existing provider sessions, refresh credentials, school settings, students and memberships were fingerprinted before/after and remained unchanged. Both new private tables force RLS; browsers and platform runtime roles cannot read private session history or execute session controls directly. Security advisor findings were unchanged from the inspected baseline.
- Installation encountered an older calendar migration checksum mismatch. Reconciliation verified its exact live function body (normalizing line endings), trigger type, fixed search path and browser-denied privileges against the repository, then updated only the stale checksum metadata with an audit entry and pinned line endings. No calendar behavior or school records changed.
