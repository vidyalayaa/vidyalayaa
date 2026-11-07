# School notifications with Firebase Cloud Messaging

School Admin → **Notifications** now contains **My notifications**, **Send notification**, **School history**, and **Automatic alerts**. This extends the existing outbox, delivery ledger, encrypted push endpoints and background worker; it does not create a second notification system or change Supabase authentication.

## Sending a custom notification

1. Choose individual active school accounts, one or more roles, or the entire school. Search individual accounts by name or email. Parent, student, teacher, Principal, School Admin and finance staff accounts are supported. A person must first accept their school invitation and have an active account and membership. A student/parent directory record alone is not a login account or an FCM subscription.
2. Enter a title (120 characters maximum) and message (1,000 characters maximum).
3. Review recipients and enabled-device counts. Confirm to queue the message. The confirmed account IDs are snapshotted, so a newly joined member is not silently added later. A message supports up to 5,000 accounts; send separate batches for larger schools.
4. Follow School history → Delivery details. `SENT` means FCM accepted the request, **not** that the person received or read it. Members without a registered device can still read their targeted message under My notifications. Delivery history records `NO_ENABLED_DEVICE` for push suppression.

School Admin can cancel pending/processing notifications with a reason or retry eligible failed deliveries, missing-device suppressions and school-policy suppressions. Retries preserve successful per-device acknowledgments. Sent content cannot be edited or recalled; send a new correction instead. Cancellation cannot stop a provider request already in flight.

Principal retains the existing school-wide notification-history visibility, with no send/settings/cancel/retry controls. Other school roles have their own inboxes only. Platform staff have no automatic access to school recipient data. Administrators never receive raw device tokens or private session credentials.

## Super Admin scheduling

Open **Platform → School notifications** and choose an active school with an eligible subscription. Choose **Send now** or **Schedule for later**, then enter a date and time in the displayed school timezone. The scheduled time must be in the future and within one year. The queue targets the selected school's active members at the time of scheduling and rechecks membership and delivery preferences when the worker processes it.

Use **Scheduled and sent notifications** to review the status and cancel a message before the worker starts processing it. School notification settings, opted-in devices and the existing Firebase worker control push delivery. The selected time is when the message becomes eligible for processing. If the worker is offline, processing resumes when it comes back.

Choose **Send daily** to repeat the message every day, including weekends, at a fixed local time in the school's timezone shown when creating the schedule. **Daily schedules** shows the next send time and lets Super Admin stop future occurrences. Each occurrence targets active members when the worker queues it. If the worker is offline, it can still queue today's occurrence after resuming, but it skips missed days. Already queued messages retain their existing delivery and cancellation rules. Apply `20261107175000_platform_daily_notifications.sql` before deploying the updated worker and API.

## Automatic alert controls

The School Admin can disable all school delivery, individual channels (FCM push, email, SMS), or individual types: arrival, departure, absence, attendance correction, fee reminder, announcement, device alert, subscription update, and custom messages.

Controls apply when the worker processes the message and are checked again before sending. Disabled work becomes `SUPPRESSED / SCHOOL_POLICY_DISABLED`; re-enabling does not silently replay it. An administrator can explicitly retry an eligible suppressed delivery with a reason. User opt-outs, parent quiet hours and parent lock-screen privacy are preserved. Account-private login-security alerts remain independent of school controls. Existing email/SMS providers remain supported; custom messages use **FCM only**. Staff announcements and device/subscription recipients now also support push alongside existing email.

## Firebase setup

Use one Firebase project for the web client and the worker service account. In Firebase Console:

1. Register the web application. Copy its public web configuration.
2. In Project settings → Cloud Messaging → Web Push certificates, generate or select a Web Push key pair. Use its **public** key as `VITE_FIREBASE_VAPID_KEY`.
3. Ensure the Firebase Cloud Messaging HTTP v1 API is enabled. For older projects, the FCM Registration API may also need enabling.
4. Supply a service account authorized to send FCM messages to the **worker's server environment only**. Keep its private key out of Git, frontend environment variables and browser code. The existing worker accepts the service-account JSON encoded in base64 as `FIREBASE_SERVICE_ACCOUNT_BASE64`; base64 is encoding, not encryption.

Web environment (`apps/web/.env.local` locally, frontend build secrets/settings when deployed):

```dotenv
VITE_FIREBASE_API_KEY=your-public-web-api-key
VITE_FIREBASE_PROJECT_ID=your-firebase-project-id
VITE_FIREBASE_MESSAGING_SENDER_ID=your-project-sender-id
VITE_FIREBASE_APP_ID=your-web-app-id
VITE_FIREBASE_VAPID_KEY=your-public-web-push-key
```

Worker environment (Render secret environment; `apps/worker/.env` locally when using `npm run dev`):

```dotenv
FIREBASE_SERVICE_ACCOUNT_BASE64=your-private-service-account-json-encoded-as-base64
PUBLIC_WEB_URL=https://your-vidyalayaa-hostname.example
TOKEN_ENCRYPTION_KEY=the-existing-shared-api-and-worker-encryption-key
```

Do not replace an existing token encryption key without the application's key-rotation process: older endpoints need that key to decrypt. Do not put the service account in Firebase Hosting, `VITE_*`, the public service worker, or an administrator-facing settings form.

Each user clicks **Enable notifications** in Notifications or Settings on each device and allows the browser permission. The browser requires HTTPS in production; localhost is permitted for development. Keep `/firebase-messaging-sw.js` available at the origin root as JavaScript, not an HTML SPA fallback. The first-party worker displays background notifications and signals visible tabs to refresh their inbox. Notification clicks return to the authenticated notifications route. For multiple school memberships, select the corresponding school before reviewing its inbox. Supported browsers/devices vary; iOS web push requires an installed Home Screen web app on supported OS versions.

The application uses the existing registration-token API supported by its installed Firebase SDK. Do not interchange tokens with Firebase Installation IDs without migrating the client and server together.

References: [Firebase web setup](https://firebase.google.com/docs/cloud-messaging/web/get-started), [receiving messages](https://firebase.google.com/docs/cloud-messaging/web/receive-messages), [token management](https://firebase.google.com/docs/cloud-messaging/manage-tokens).

## Deployment and migration

Run from the repository root using the supported Node 24 runtime:

```powershell
npm ci
npm run build
npm run lint
npm run check:secrets
npx vitest run
npx playwright test tests/e2e/notifications.spec.ts tests/e2e/notifications-family.spec.ts tests/e2e/notifications-staff.spec.ts --workers=1
npm run db:migrate
npm run db:verify
```

Use the existing deployment guide for database runtime roles, TLS and migration credentials. The migrations are `db/migrations/20261024085300_school_notifications.sql`, `db/migrations/20261024093039_notification_queue_role_guard.sql`, and `db/migrations/20261024093708_notification_purge_cleanup.sql`. The second keeps the checked queue mandatory for production logins that inherit the API role. Together they add settings, immutable recipient snapshots, cancellation/author fields and scoped database policies. Existing deliveries, encrypted device tokens, school records and native authentication sessions are preserved. Default controls are enabled, so existing automatic alerts continue working.

Deploy the updated worker and API before enabling the updated web UI. A database compatibility policy hides `CUSTOM` jobs from old workers, preventing them from accidentally interpreting targeted messages as legacy parent broadcasts. Updated transactions set the `custom-v1` processing capability. Do not remove that policy during a rolling deployment. Restart the API and worker so existing processes load the updated code, then deploy/rebuild the frontend so its public Firebase configuration is included. Use the repository's existing Render/Firebase configuration and GitHub Actions deployment workflow.

For rollback, stop composing new messages, cancel pending custom jobs through the updated API, and roll back application releases while retaining the additive migration and historical records. Older workers cannot deliver custom jobs. Prefer a corrective forward migration; do not drop recipient snapshots, delivery history or encryption keys. Re-run database verification and security advisors after migration.

## API contracts

All paths are under `/api/v1`; school requests require the existing bearer session and `X-School-Id`. Runtime authentication, subscription, active membership and RLS checks still apply.

| Endpoint | Access and behavior |
|---|---|
| `GET /notifications` | Own inbox; legacy school-wide delivery history remains available to School Admin/Principal through school history. Paginated. |
| `GET /notifications/members?search=&role=&page=1&page_size=25` | School Admin; active own-school accounts and enabled-device counts. |
| `POST /notifications/preview` | School Admin; validates the compose body and returns `user_ids`, `recipients`, `push_ready`, `devices`. |
| `POST /notifications/messages` | School Admin; compose body, required 8–200-character `Idempotency-Key`; returns HTTP 202 with queued ID and counts. |
| `GET /notifications/messages?kind=&status=&page=1` | School Admin/Principal; queue history and aggregate accepted/failed counts. |
| `GET /notifications/messages/:id/deliveries?page=1` | School Admin/Principal; delivery status without device credentials. |
| `POST /notifications/messages/:id/cancel` | School Admin; `{ "reason": "At least five characters" }`; only pending/processing work. |
| `POST /notifications/:deliveryId/retry` | School Admin; audited reason, only eligible uncancelled deliveries. |
| `GET /notifications/settings` | School Admin; current controls with optimistic `version` (0 before first save). |
| `PUT /notifications/settings` | School Admin; complete enabled/channel/kind flags and last loaded `version`; stale saves return 409. |
| `GET /platform/notifications/daily` | Super Admin with MFA; paginated schedule status and next send time. |
| `POST /platform/notifications/daily` | Super Admin with MFA; accepts `school_id`, `title`, `body`, `local_time` (24-hour HH:MM) and an `Idempotency-Key`; returns HTTP 201 and the schedule ID. |
| `POST /platform/notifications/daily/:id/cancel` | Super Admin with MFA; stops future occurrences. |
| `POST /push-tokens` | Any active school role; `{ "token": "FCM registration token", "platform": "WEB" }`; token is hashed/encrypted server-side. |
| `DELETE /push-tokens` | Own endpoint only; `{ "token_hash": "sha256 hex digest" }`. |

Compose body:

```json
{
  "title": "Parent meeting",
  "body": "Please check the meeting details in your school account.",
  "audience": "ROLES",
  "roles": ["parent"],
  "user_ids": []
}
```

`audience` can be `ALL`, `ROLES`, or `MEMBERS`. `MEMBERS` requires UUID account IDs, not student/parent directory-record IDs. The UI confirms the preview using `MEMBERS` and the previewed IDs. Duplicate/reused request keys with different content are rejected; matching retries return the original queue item. OpenAPI is generated from the shared runtime schemas with `npm run contracts`.

## Reliability and troubleshooting

- **No push**: check browser permission, HTTPS, root service-worker availability, VAPID key, matching Firebase project and sender ID, worker logs and delivery status. After changing frontend configuration, rebuild/redeploy it. Credentials are required for actual FCM delivery; local tests simulate FCM and never send to real accounts.
- **Provider unconfigured**: set the worker service account; do not paste its private key into chat or frontend settings. Verify worker and API share the existing encryption key.
- **Suppressed**: inspect the reason. School controls, recipient preferences, absent device registration, subscription restrictions, stale jobs or changed access may suppress delivery. Do not override a recipient's browser permission or privacy choice.
- **Failed/dead**: retry only after fixing the provider/device problem. Permanently invalid endpoints are disabled; successful device targets are skipped on retry.
- **Duplicate notification**: FCM has no request idempotency guarantee. Database deduplication and per-device acknowledgments prevent normal replay, and stable browser tags replace the visible notification card. If FCM accepted a request but its response was lost, a retry can still deliver again. Delivery is at least once, not exactly once.
- **Access changed**: suspended users and removed school memberships cannot receive new custom push or read the old school's inbox. Push already accepted by FCM cannot be revoked remotely.

## Verification

The automated suite uses real PostgreSQL behavior via disposable database fixtures, non-bypass runtime roles, actual Express routes and simulated provider sessions/FCM. Browser tests cover desktop/mobile compose, recipient preview, cancellation, settings persistence, and read-only parent/student/staff inboxes. Upgrade tests compare existing records before/after migration. The worker's existing per-device retry tests cover permanent invalidation and transient failure recovery. These checks do not establish live-provider delivery or validate credentials in an external Firebase project.

New recipient snapshots are removed through the existing outbox deletion cascade. New school alert configuration is removed only when the existing approved purge transitions the school from PURGING to PURGED; other schools and immutable audit records remain intact.

## Verification record — 24 October 2026

- Full regression suite: **259 tests passed** across 44 files before the final role/purge hardening. Final focused checks also passed: **40** notification/teacher/worker/upgrade tests and **31** notification/offboarding/worker/upgrade tests, including inherited API logins, suspended-account access, revoked-recipient suppression and school-scoped purge cleanup. These focused counts overlap the full suite.
- Browser checks: **12 passed**, across desktop and mobile. Recipient preview, queuing, cancellation, settings persistence, private family/staff inboxes and accessibility checks passed using isolated services. No real provider messages were sent.
- Production builds, TypeScript checks, source lint, generated OpenAPI and secret-pattern checks passed. The API was rebuilt after its final response-shape change.
- All three additive migrations were applied to the connected Supabase project. Existing school records, native Auth sessions/refresh credentials and notification history/endpoints were compared before/after and preserved. The later migrations also verified existing notification settings and recipient snapshots.
- Read-only checks under the actual non-owner API login verified recipient lookup, default FCM controls and zero foreign-school queue rows. Browser-role access to the private queue is denied, and both new tables force RLS.
- Supabase security advisors introduced **no new findings**. The pre-existing baseline remains: 5 informational deny-all/no-policy tables, 9 [mutable function search paths](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable), 2 [extensions in public](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public), and disabled [leaked-password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). Those unrelated settings were preserved.
- The local frontend Firebase configuration is present. The local worker's `FIREBASE_SERVICE_ACCOUNT_BASE64` is **not configured**, so live FCM delivery remains unverified and requires that external credential plus device permission. Credentials were never printed or committed.
