# Vidyalayaa REST API

Base: `/api/v1`. The generated `docs/api/openapi.json` describes shared Zod request schemas; regenerate with `npm run contracts`. Server refinements enforce window ordering, relationship scope, plan limits and exam locking in addition to the generated JSON Schema.

## Identity and school selection

Send `Authorization: Bearer <Supabase access JWT>`. The API verifies it with Supabase Auth on every request, rejects disabled application accounts, and reads roles/permissions from active database memberships. `X-School-Id` selects an authorized membership; it cannot grant one. A single-school user can omit it. Cross-school and unknown resource IDs share a 404 error shape. Platform routes require the separately stored SUPER_ADMIN role and an `aal2` token.

`GET /me` returns `{id,full_name,email,memberships,school,platform_role,features,limits,subscription_status}`. `GET /dashboard` returns scoped statistics, seven-day attendance, recent records, notices and authorized device-health aggregates. No client-provided role is trusted.

Errors: `{error:{code,message,details?},request_id,server_time}`. Stable statuses: 401 session/credential failure; 403 permission/MFA/feature/subscription restriction; 404 absent or outside scope; 409 business/uniqueness/version conflict; 422 validation; 429 throttling with Retry-After; 503 unavailable dependency. Device responses always carry server time (204/304 use `X-Server-Time`).

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
| PATCH /school | name, IANA timezone; school.manage |
| GET /profile/parent | Own parent ID/name for notification preferences |
| POST /fees/{id}/remind | Outstanding fee reminder, once daily per fee; fees.write |
| GET /subscription | Effective flags/limits/state; subscription.read |
| GET /audit | Latest 100 append-only school audit summaries; audit.read |
| GET /notifications | Delivery history; own parent deliveries or authorized school administrator view |
| POST /push-tokens | token, WEB/ANDROID/IOS; stored encrypted, lookup hash; parent preferences permission |
| DELETE /push-tokens | token_hash; deactivate this user's current device token |
| POST /materials/upload | class_id, filename (PDF/PNG/JPEG); scoped signed upload to private materials path |
| GET /materials/{assignment_id}/download | Authorized short-lived private material download |
| GET/POST /reports | Own report list / kind ATTENDANCE/ACADEMIC/FEES, from/to, optional student_id/class_id |
| GET /reports/{id}/download | 60-second application-signed URL bound to actor, school and report |
| GET /reports/{id}/file | Requires the same JWT, membership, report scope, expiry and signature; streams private PDF |
| GET /support-grants | School administrator reviews time-boxed support requests |
| POST /support-grants/{id}/decision | approve boolean; grant revocation is immediate |

Parents/students must choose a linked/self student when creating reports. Teachers' exports remain assigned-class/subject scoped. Report generation rechecks membership at processing time; downloads recheck it again. URLs are signed at the application boundary and also require JWT authorization, so copying another user's URL does not grant access. Raw storage report URLs are not exposed.

## Platform operations

GET `/platform/schools`, `/platform/devices`, `/platform/plans`, `/platform/support-grants` return metadata only through app_platform, which has no student/attendance/fee/mark table privilege. POST `/platform/schools` creates a school plus trial subscription (school_code, name, timezone, plan_code, trial_ends_at). PATCH `/platform/schools/{id}/subscription` changes plan_id, status, current_period_end, grace_ends_at, optional limit_overrides and requires a reason. Every change is audited and recorded in subscription_events.

POST `/platform/devices` takes school_id, device_code, name, hardware_serial. Response includes unique device_secret and claim_code **once** with Cache-Control no-store; database stores only SHA-256 hashes. Never put this credential in web configuration. POST `/platform/devices/{id}/rotate` and `/revoke` require a reason. Rotation overlaps credentials for 24 hours; revocation is checked on every request and every event.

POST `/platform/support-grants`: school_id, reason, ticket_ref, scope array (`students`, `attendance`, `marks`, `fees`), minutes 1-1440. School Admin approval is mandatory. GET `/platform/support-grants/{id}/{feature}` reads up to 100 permitted rows while approved/unexpired, using a read-only tenant transaction; every returned record is separately audited against the grant.

## Provider-neutral billing webhook

`POST /billing/webhook` is disabled without BILLING_WEBHOOK_SECRET. It is an adapter contract, not a claim of integration with any selected payment vendor. A chosen vendor adapter must verify its vendor signature before transforming to `{id,school_id,status:ACTIVE|PAST_DUE|CANCELLED,current_period_end}`. Send X-Webhook-Timestamp (Unix seconds) and X-Webhook-Signature (hex HMAC-SHA256 of `timestamp + '.' + raw JSON bytes`). The API checks a five-minute replay window and constant-time signature, then applies an idempotent metadata-only database function. Identical event IDs cannot change payloads. Fee payment collection and vendor invoices remain outside SAS v1's selected-provider scope.

## Health and limits

`GET /health/live` is process liveness; `/health/ready` checks database connectivity. Production TLS terminates at Render. The API uses an explicit origin allowlist and verified database TLS. User data is not logged. Per-instance in-memory throttling must be moved to a shared store before scaling API instances where aggregate limits are required. See `docs/DEVICE_API.md` for NFC-specific bodies, per-event commit semantics and firmware behavior.
