# Vidyalayaa REST API

Base: `/api/v1`. The generated `docs/api/openapi.json` describes shared Zod request schemas; regenerate with `npm run contracts`. Server refinements enforce window ordering, relationship scope, plan limits and exam locking in addition to the generated JSON Schema.

## Identity and school selection

Send `Authorization: Bearer <Supabase access JWT>`. The API verifies it with Supabase Auth on every request, rejects disabled application accounts, and reads roles/permissions from active database memberships. `X-School-Id` selects an authorized membership; it cannot grant one. A single-school user can omit it. Cross-school and unknown resource IDs share a 404 error shape. Platform routes require the separately stored SUPER_ADMIN role and an `aal2` token.

`GET /me` returns `{id,full_name,email,memberships,school,platform_role,features,limits,subscription_status}`. `GET /dashboard` returns scoped statistics, seven-day attendance, recent records, notices and authorized device-health aggregates. No client-provided role is trusted.

Email/password and Google OAuth both supply Supabase access tokens to the same API. If the verified Auth user has an enrolled factor, all authenticated API routes require an `aal2` token and otherwise return `403 MFA_REQUIRED`. Platform routes require `aal2` regardless of enrollment. Google profile/provider claims never grant roles or memberships. The web-only Google PKCE callback is `/auth/google/callback`; invitation/password setup retains `/auth/callback`. Provider setup is documented in `GOOGLE_SIGN_IN.md`.

Errors: `{error:{code,message,details?},request_id,server_time}`. Stable statuses: 401 session/credential failure; 403 permission/MFA/feature/subscription restriction; 404 absent or outside scope; 409 business/uniqueness/version conflict; 422 validation; 429 throttling with Retry-After; 503 unavailable dependency. Device responses always carry server time (204/304 use `X-Server-Time`).

All list endpoints use bounded `page` and `page_size` (1-100) where documented. Audit and notification feeds additionally accept `cursor=1`, `page_size` and the previous `next_cursor` as `after`; the response includes `next_cursor` or null. Cursors contain the last timestamp/UUID tuple, are validated, and retain stable descending order while new events arrive. They do not convey authorization. Without cursor=1, offset pagination remains available. Relation label fields are computed only from records the caller is already authorized to read.

## Invitation lifecycle

`GET /invitations/pending` and `POST /invitations/{id}/respond` (`{accept:boolean}`) are authenticated identity endpoints that do not require an existing school membership or X-School-Id. They operate only on the verified recipient email. New identities first complete Supabase invitation verification/password setup; existing verified identities keep their current account and accept the invitation in Settings.

School `GET /invitations`, `POST /invitations` (`email,full_name,role`), `POST /invitations/{id}/resend` and `POST /invitations/{id}/cancel` require users.manage. Role is one of school_admin, principal, teacher, parent or student; SUPER_ADMIN cannot be invited through a school. Pending school membership remains INVITED. Acceptance creates ACTIVE access transactionally; decline/cancellation prevents acceptance. Membership PATCH cannot bypass acceptance or remove/demote the last ACTIVE School Admin.

States are SENDING (dispatch lease), SENT (new account setup mail), READY (existing account), ACCEPTED, REVOKED and FAILED. Invitations expire after seven days. Repeated clicks reuse a valid in-flight lease; dispatch retries become available after two minutes. Expired/revoked/failed invitations can be intentionally resent while the sender still has authority. Responses distinguish sent setup email from in-app acceptance for existing accounts. A failed provider never appears as successfully sent.

## School resources

`GET /resources/{resource}` accepts `page` (1+), `page_size` (1-100), `search` and supported `class_id`; returns `{data,total,page,page_size}`. `GET /resources/{resource}/{uuid}` reads one scoped row. `POST` creates; `PATCH` updates allowed fields. No hard-delete endpoint exists for academic or attendance history. Use lifecycle statuses. Request fields are the generated Zod schemas; unknown columns, roles and tenant IDs are refused.

Allowed resource names: students, parents, teachers, academic_sessions, classes, subjects, enrollments, student_parents, teacher_class_assignments, exams, marks, assignments, timetable_entries, school_holidays, announcements, fee_records, nfc_cards, device_locations, attendance_rule_versions, notification_preferences. The registry in `modules/school/resources.ts` maps each to permission and scope; it is never derived from an arbitrary SQL identifier.

Create requests accept `Idempotency-Key` (8-200 safe characters). Reusing a key with a different body returns IDEMPOTENCY_CONFLICT; an identical retry returns its committed result. Use UUIDs and retain the same key when retrying after a lost response. Rule versions are immutable; create a new version. A later version closes an earlier open effective range; overlaps are rejected by PostgreSQL. Timetable exclusion constraints prevent double booking. Student and device counts are checked under transaction locks.

Teachers see assigned classes and student rosters; subject writes and academic reports require their assigned subject or class-teacher assignment. Parents see active linked children and published exams only. Student accounts see their own linked student row. Revoked links apply on the next request.

## Operational endpoints

| Method/path | Contract / permission |
|---|---|
| GET /attendance?date=YYYY-MM-DD | Scoped paginated daily register, attendance.read |
| POST /attendance/manual | student_id, date, status, reason, optional expected_version; manual_write |
| GET/POST /corrections | Scoped requests / daily_attendance_id, requested_status, reason |
| POST /corrections/{id}/decision | `{approve:boolean}`; correct_approve; another reviewer required |
| POST /marks/bulk | exam_id and 1-500 `{student_id,subject_id,score,remarks?}`; atomic UPSERT; marks.write |
| GET /devices | Own-school public device metadata; devices.read |
| POST /devices/claim | device_code, claim_code, name, location_id; devices.manage |
| PATCH /devices/{id} | name, location_id, ACTIVE/DISABLED/REVOKED status, reason, optional safe config |
| POST /invitations | email, full_name, school role; users.manage; invitation through Supabase Auth |
| GET/PATCH /memberships/{id?} | List accounts / role and status changes; users.manage; self-change prohibited |
| PATCH /school | name, IANA timezone, en-IN/hi-IN locale; school.manage |
| GET/PUT/DELETE /school/retention | Read, approve or disable future opt-in cleanup; school.manage; PUT needs approved=true, policy_ref, report_days and notification_days (7-3650) |
| GET /lookups/accounts?role=teacher | Active named school accounts for teacher/parent/student profile linking; users.manage; paginated search |
| GET /devices/{id}/configurations | Versioned configuration snapshots with reason/editor; devices.read; paginated |
| GET /profile/parent | Own parent ID/name for notification preferences |
| POST /fees/{id}/remind | Outstanding fee reminder, once daily per fee; fees.write |
| GET /subscription | Effective flags/limits/state; subscription.read |
| GET /audit | Paginated append-only school audit summaries; audit.read; optional cursor mode |
| GET /notifications | Paginated delivery history; active linked parent scope rechecked immediately; optional cursor mode |
| POST /push-tokens | token, WEB/ANDROID/IOS; stored encrypted, lookup hash; parent preferences permission |
| DELETE /push-tokens | token_hash; deactivate this user's current device token |
| POST /materials/upload | class_id, filename (PDF/PNG/JPEG); scoped signed upload to private materials path |
| GET /materials/{assignment_id}/download | Authorized short-lived private material download |
| GET/POST /reports | Own report list / kind ATTENDANCE/ACADEMIC/FEES, from/to, optional student_id/class_id |
| GET /reports/{id}/download | 60-second application-signed URL bound to actor, school and report |
| GET /reports/{id}/file | Requires the same JWT, membership, report scope, expiry and signature; streams private PDF |
| GET /support-grants | School administrator reviews time-boxed support requests |
| GET /support-access | Own-school active approved support grants for the security notice; users.manage |
| POST /support-grants/{id}/decision | approve boolean; grant revocation is immediate |

Parents/students must choose a linked/self student when creating reports. Teachers' exports remain assigned-class/subject scoped. Report generation rechecks membership at processing time; downloads recheck it again. URLs are signed at the application boundary and also require JWT authorization, so copying another user's URL does not grant access. Raw storage report URLs are not exposed.

Bulk mark writes validate every row before UPSERT. Invalid enrollment/score returns 422 BULK_VALIDATION_FAILED with `error.details:[{path:['entries',zeroBasedRow,'score'|'student_id'],message}]`; no row is saved. Zod request errors expose `error.issues` with equivalent paths. A successful retry with the same idempotency key returns the original committed result. Academic PDFs summarize recorded subject scores per exam/student using the exam maxima; they do not invent grades or treat missing subjects as zero.

Retention never starts without an approved school policy. Report expiry removes the private generated file before marking its report row EXPIRED; underlying source records remain. Notification pruning affects only old terminal COMPLETED jobs and their delivery records. Pending/dead jobs and application audit history remain available. Disabling the policy stops subsequent cleanup cycles.

## Platform operations

GET `/platform/schools`, `/platform/devices`, `/platform/plans`, `/platform/support-grants` return metadata only through app_platform, which has no student/attendance/fee/mark table privilege. POST `/platform/schools` creates a school plus trial subscription (school_code, name, timezone, plan_code, trial_ends_at); an absent or inactive plan returns 422 and creates neither record. PATCH `/platform/schools/{id}/subscription` saves plan_id (or plan_code), status, current_period_end, grace_ends_at, optional limit_overrides and a required reason. It initializes a subscription if the authorized school has none, and otherwise updates its latest subscription. School-row locking serializes first-time setup; repeated saves reuse the record. Missing schools return 404. Initialization requires an active plan; existing subscriptions may retain their current inactive plan. Omitted overrides/grace dates preserve existing values, while `{}`/`null` explicitly clear them. Every save is audited and recorded in subscription_events; the first event has previous_status=null. No database migration is required for this recovery flow.

POST `/platform/schools/{id}/administrator-invitation` (`email,full_name,resend?`) and POST `/platform/schools/{id}/administrator-invitation/{invitation}/cancel` bootstrap or cancel only the first School Admin invitation. An already staffed/onboarded school cannot use platform bootstrap for routine membership changes. These functions return safe invitation summaries rather than a general account directory. All platform routes require verified MFA.

PATCH `/platform/plans/{id}` takes name, active status, defined feature flags/numeric limits and reason; plan code is immutable. Subscription changes validate the selected plan and known limit names. Omitted overrides/grace fields retain stored values; `{limit_overrides:{}}` explicitly clears overrides. GET `/platform/operations` returns aggregate school/plan usage, report/notification backlogs, quarantine/sequence gaps and private worker state; missing/stale workers are not reported as healthy. Its website route is `/platform/health`.

POST `/platform/devices` takes school_id, device_code, name, hardware_serial. Response includes unique device_secret and claim_code **once** with Cache-Control no-store; database stores only SHA-256 hashes. Never put this credential in web configuration. POST `/platform/devices/{id}/rotate` and `/revoke` require a reason. Rotation overlaps credentials for 24 hours; revocation is checked on every request and every event.

POST `/platform/support-grants`: school_id, reason, ticket_ref, scope array (`students`, `attendance`, `marks`, `fees`), minutes 1-1440. School Admin approval is mandatory. GET `/platform/support-grants/{id}/{feature}` reads up to 100 permitted rows while approved/unexpired. The live grant is revalidated and locked in the same tenant transaction that reads and separately audits every returned record. Revocation prevents the next read and waits for an already authorized read transaction to finish. The browser hides the support view on expiry or failed authorization refresh.

## Provider-neutral billing webhook

`POST /billing/webhook` is disabled without BILLING_WEBHOOK_SECRET. It is an adapter contract, not a claim of integration with any selected payment vendor. A chosen vendor adapter must verify its vendor signature before transforming to `{id,school_id,status:ACTIVE|PAST_DUE|CANCELLED,current_period_end}`. Send X-Webhook-Timestamp (Unix seconds) and X-Webhook-Signature (hex HMAC-SHA256 of `timestamp + '.' + raw JSON bytes`). The API checks a five-minute replay window and constant-time signature, then applies an idempotent metadata-only database function. Identical event IDs cannot change payloads. Fee payment collection and vendor invoices remain outside SAS v1's selected-provider scope.

## Health and limits

`GET /health/live` is process liveness; `/health/ready` checks database connectivity. Production TLS terminates at Render. The API uses an explicit origin allowlist and verified database TLS. User data is not logged. Per-instance in-memory throttling must be moved to a shared store before scaling API instances where aggregate limits are required. See `docs/DEVICE_API.md` for NFC-specific bodies, per-event commit semantics and firmware behavior.

The Render worker has no public HTTP listener. Its private database heartbeat is checked by `npm run health:live -w @vidyalayaa/worker` and `npm run health:ready -w @vidyalayaa/worker`: liveness requires a recent heartbeat, readiness additionally requires a RUNNING worker with a successful cycle within five minutes. Provider/channel rate buckets are shared in PostgreSQL. Each push token has its own result; invalid tokens are disabled independently, successfully sent targets are not repeated on transient retries, and recipient errors do not trip the provider outage circuit. English/Hindi message templates omit child names from provider text by default.
