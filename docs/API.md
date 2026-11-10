# Vidyalayaa REST API

The [Subject study materials](SUBJECT_MATERIALS.md) panel reuses assignments with `kind=MATERIAL`. `GET /materials` requires `class_id` and `subject_id` and accepts pagination. `GET /parent/children/:childId/materials` additionally checks the selected linked child. Lists expose notes and filenames, without private storage paths. Uploads reuse `POST /materials/upload` with `class_id`, optional `subject_id` for compatibility, and filename; subject uploads validate the exact teacher/class/subject relationship. Existing record create/edit/archive and authenticated, reauthorized file endpoints remain the source of truth.

The [Student learning pages](STUDENT_LEARNING.md) use `GET /student/academics` (no query parameters) and `GET /student/results` (optional `exam_id`, `subject_id`, `page`, `page_size`, maximum page size 100). Both derive the student from the authenticated account and active school; student/user/class ID overrides are rejected. Results include only the student's published, non-retired examinations, with class/session/subject labels, recorded zero scores and performance summaries. There is no implicit date window that hides older results. Results from ended enrollments remain available. These projections and their underlying database policies are read-only for students.

### School results and academic analytics

School Admin and Principal use these school-scoped endpoints with `marks.read`.

| Path | Purpose |
| --- | --- |
| `GET /results/examinations?session_id=` | Examination catalogue with a representative `cohort_id` for each comparable group |
| `GET /results/exams/{id}/students` | Searchable, paginated examination roster |
| `GET /results/exams/{id}/students/{student}` | Subject scores, maxima, recorded percentage, configured grades and applicable ranks |
| `GET /results/analytics?session_id=&cohort_id=&grade=&class_id=` | Class and subject comparisons, distribution, toppers and trends. Grade and class ID are optional. |
| `GET /results/policy` | Current grading policy |
| `PUT /results/policy` | School Admin saves `pass_percentage` and grade bands. Requires `school.manage` and a writable subscription. |

Comparisons group section exams by academic session, normalized exam name, exam type, and assessment kind. Subject tests also match subject name. Multiple matching exams in the same section remain separate. The roster uses exam-date enrollments and includes students with recorded marks. For an undated exam, active enrollments also qualify. A mark of zero is a recorded result. Rows without marks stay in roster totals and are excluded from appeared counts, percentage averages, and rankings. The system has no exam-specific absence status.

An official examination's subject list comes from the subjects recorded for that exam. Incomplete results retain their recorded-subject percentage and are excluded from overall grades, pass/fail counts, and rankings. Complete published results rank by the displayed two-decimal percentage. Equal percentages share a competition rank. School ranks use the full cohort, while the class and section filters narrow the displayed rows. A student with two qualifying results in the same cohort keeps each class rank and is excluded from the school ranking. Exam and session trends use published results of the selected assessment kind and match the subject for subject tests.

Grades and pass/fail require a school-configured policy. That policy classifies the calculated overall percentage against the pass threshold and applies the highest qualifying grade band. Policy changes apply when results are viewed. Existing mark records, exam publication, teacher permissions and family access continue through their established routes.

The [Student profile page](STUDENT_PROFILE.md) uses `GET /student/profile` with the authenticated student session and active school. No student ID, user ID or query parameters are accepted. It returns only personal fields, school identifiers, active linked guardian contacts and the student's enrollment history. Profile writes are rejected. Restrictive database policies also scope the underlying student/family/enrollment records to the authenticated student. The endpoint does not return private account credentials or accept email-based identity matching.

The [Parent workspace](PARENT_WORKSPACE.md) exposes `/parent/children` and checked,
child-scoped read projections at `/parent/children/:childId/*`. These reuse the
existing records, calendar and timetable, with restrictive database family RLS.
Parents can request corrections and reports through the existing checked workflows;
they cannot write official records or view other families.

Parent attendance supports `from`, `to`, `status`, `page` and `page_size`, returning
every date plus full-range school-day/absence totals and recorded attendance
percentage. `GET /parent/children/:childId/results/insights` accepts `from`, `to`,
`exam_id` and `subject_id` and returns published marks, weighted summaries and
subject/examination chart series. Ranges are limited to 366 days and attendance
never fabricates an absence for a missing record. See the Parent workspace guide
for calendar classification and percentage definitions.

The [weekly timetable](TIMETABLE.md) reuses `timetable_entries` and stores validated school timings in existing school settings. `/timetable/*` supplies versioned timings and role-scoped class/lecture choices; existing resource CRUD and retirement routes remain the lecture write contracts. Only School Admin can write, with database-enforced assignments, periods, role/ownership rules and overlap constraints.

`GET /timetable/mine` returns only the authenticated teacher's own lectures across live assigned classes and subjects, with class, section, subject and teacher display labels. It does not accept a teacher identity and rejects other school roles. Authorized class timetables still include all lecturers. `GET /timetable/clock` returns `{server_time, timezone}` without caching; the selected-child parent route also supports this clock. The browser uses this sample to highlight actual lecture intervals in school-local time and resynchronizes when the tab becomes active. These read endpoints retain the timetable feature, authentication, school selection and read-permission gates.

School Admin's [class-wise Results](CLASS_WISE_RESULTS.md) select a class/section and its examination before entering or importing marks. `GET /resources/marks?class_id=...&exam_id=...` intersects both scopes; `GET /resources/subjects?class_id=...` returns configured section subjects. Existing examination, student, individual-mark and bulk-mark endpoints remain the source of truth.

Class Teacher official-mark subject choices also intersect the selected class's configured subjects; being assigned to other classes does not mix their subjects into these choices. School Admin Homework subject fields require a class first and use the same class filter. New homework, subject tests and marks with an unrelated subject are rejected by database guards. Students' unfiltered subject lists are additionally restricted by RLS to their own current class/enrollment and dated teaching relationships. Migration `20261029180825_class_subject_visibility.sql` adds these guards without rewriting saved records; unchanged historical scopes remain editable according to their existing role/status permissions.

The [student and family admission form and class-wise student directory](STUDENT_ADMISSION.md) use `/student-directory/*`. School Admin and Principal can read the school-scoped `classes` and `students` lists. School Admin's `POST /student-directory/admissions` atomically saves a student, class enrollment, one or two new/existing parents, and their family connections. Existing email matches require explicit parent selection; this workflow does not create Auth accounts or send invitations.

[Complete student CSV import/export](STUDENT_CSV.md) uses `POST /student-directory/imports` (preview or atomic, idempotent commit) and `GET /student-directory/export.csv` (streamed, school-scoped student/enrollment/family records, optional search/session filter). Both are School Admin only. The blank import template includes every admission field; exports also preserve read-only enrollment/parent/link statuses and formula protection. The legacy record-only `/imports/students` contract remains compatible.

Student and staff profiles use the existing person IDs. Staff read their own record at `GET /profiles/staff/me`. School Admin manages contact or professional fields at `PATCH /profiles/{kind}/{id}`, where `kind` is `student` or `staff`. Photos are returned as authenticated JPEG bytes from `GET /profiles/{kind}/{id}/photo/{revision}` under the viewer's existing school and role scope. Upload uses multipart `PUT /profiles/{kind}/{id}/photo` with `image`, `expected_photo_id` (empty for a new photo), and `replace`. Removal uses `DELETE` on the same path with the expected photo ID in JSON. Both changes reject stale revisions. The private storage path is generated by the API and is never returned to clients.

School Admin can submit multipart `POST /profiles/{kind}/workbook` with a `workbook` file to normalize the first Excel worksheet for the existing record import. Separate multipart `POST /profiles/{kind}/photos/preview` takes an `archive` and returns matches and thumbnails. `POST /profiles/{kind}/photos/import` takes the same `archive` and a JSON `manifest` with the preview hash and confirmed assignments. `GET /profiles/{kind}/candidates` provides same-school manual matches. Photo import applies changes per file and reports any failed writes without creating student or staff records. Deploy the profile database migration before deploying the API and web build.

School Admin and Principal share the expandable [class-wise Academics workspace](CLASS_WISE_ACADEMICS.md) using `GET /academics/classes` and its paginated subjects and unconfigured-assignment child endpoints. Class summaries include `student_count`, `male_count`, `female_count`, `other_count` and `unspecified_count`, based on dated active enrollments and active students. No individual student roster is loaded by Academics. The enrollment-list API remains School Admin only, and enrollment management lives in student profiles. School Admin's `POST /academics/classes/{id}/subjects` atomically creates or selects a subject and assigns its required teacher to that section. Other actions reuse existing resource write APIs; no duplicate class/subject/enrollment store is introduced.

Student resource and admission contracts accept `gender: MALE | FEMALE | OTHER | NOT_SPECIFIED`, defaulting to NOT_SPECIFIED for older clients/imports. Both API validation and the database constraint reject invalid values. Student/profile responses include the persisted value; all existing role and ownership checks still apply.

The [school calendar](SCHOOL_CALENDAR.md) extends existing `school_holidays` records. `/calendar/events` provides inclusive multi-day event reads with type/section filters and role-aware visibility; `/calendar/classes` returns authorized target choices. Only School Admin can create/edit/delete, using shared calendar schemas and expected versions. Students/parents have database-enforced current-enrollment/family scope. Dashboard upcoming events reuse these endpoints. Legacy single-day holiday resource APIs remain compatible; use calendar APIs for multi-day/multi-section events.

Teacher class/subject assignment and Class Teacher examination contracts are described in [Teacher assignments](TEACHER_ASSIGNMENTS.md). This includes the additive assessment-kind migration and scoped teaching lookups.

Base: `/api/v1`. The generated `docs/api/openapi.json` describes shared Zod request schemas; regenerate with `npm run contracts`. Server refinements enforce window ordering, relationship scope, plan limits and exam locking in addition to the generated JSON Schema.

## Identity and school selection

Send `Authorization: Bearer <Supabase access JWT>`. The API verifies it with Supabase Auth on every request, rejects disabled application accounts, and reads roles/permissions from active database memberships. `X-School-Id` selects an authorized membership; it cannot grant one. A single-school user can omit it. Cross-school and unknown resource IDs share a 404 error shape. Platform routes require the separately stored SUPER_ADMIN role and an `aal2` token.

`GET /me` returns `{id,full_name,email,memberships,school,platform_role,features,limits,subscription_status}`. `GET /dashboard` returns scoped statistics, seven-day attendance, recent records, notices and authorized device-health aggregates. No client-provided role is trusted.

Email/password and Google OAuth both supply Supabase access tokens to the same API. If the verified Auth user has an enrolled factor, all authenticated API routes require an `aal2` token and otherwise return `403 MFA_REQUIRED`. Platform routes require `aal2` regardless of enrollment. Google profile/provider claims never grant roles or memberships. The web-only Google PKCE callback is `/auth/google/callback`; invitation/password setup retains `/auth/callback`. Provider setup is documented in `GOOGLE_SIGN_IN.md`.

Errors: `{error:{code,message,details?},request_id,server_time}`. Stable statuses: 401 session/credential failure; 403 permission/MFA/feature/subscription restriction; 404 absent or outside scope; 409 business/uniqueness/version conflict; 422 validation; 429 throttling with Retry-After; 503 unavailable dependency. Device responses always carry server time (204/304 use `X-Server-Time`).

All list endpoints use bounded `page` and `page_size` (1-100) where documented. Audit and notification feeds additionally accept `cursor=1`, `page_size` and the previous `next_cursor` as `after`; the response includes `next_cursor` or null. Cursors contain the last timestamp/UUID tuple, are validated, and retain stable descending order while new events arrive. They do not convey authorization. Without cursor=1, offset pagination remains available. Relation label fields are computed only from records the caller is already authorized to read.

## Invitation lifecycle

`GET /invitations/pending` and `POST /invitations/{id}/respond` (`{accept:boolean}`) are authenticated identity endpoints that do not require an existing school membership or X-School-Id. They operate only on the verified recipient email. New identities first complete Supabase invitation verification/password setup; existing verified identities keep their current account and accept the invitation in Settings.

School `GET /invitations`, `POST /invitations` (`record_id,email,full_name,role`), `POST /invitations/{id}/resend` and `POST /invitations/{id}/cancel` require `users.manage`. School invitation roles are `school_admin`, `principal`, `teacher`, `finance_staff`, `parent`, and `student`. Pending school membership remains `INVITED`. Acceptance creates `ACTIVE` access transactionally. Decline or cancellation prevents acceptance. Membership PATCH cannot bypass acceptance or remove or demote the last active School Admin.

`GET /memberships` and school `GET /invitations` accept optional `category` (`staff`, `parents`, or `students`), `role`, `search` (name or email), and `status` before pagination. Membership status filters use `ACTIVE`, `INVITED`, `SUSPENDED`, or `REMOVED`. Invitation status filters use `Pending`, `Accepted`, `Expired`, or `Cancelled` and match the returned `display_status`. Invitation responses retain the stored `status` for delivery diagnostics. `GET /memberships/counts` returns `{staff, parents, students}` for the active school across all membership statuses and requires `users.manage`.

States are SENDING (dispatch lease), SENT (new account setup mail), READY (existing account), ACCEPTED, REVOKED and FAILED. Invitations expire after seven days. Repeated clicks reuse a valid in-flight lease; dispatch retries become available after two minutes. Expired/revoked/failed invitations can be intentionally resent while the sender still has authority. Responses distinguish sent setup email from in-app acceptance for existing accounts. A failed provider never appears as successfully sent.

## School resources

`GET /resources/{resource}` accepts `page` (1+), `page_size` (1-100), `search` and supported `class_id`; returns `{data,total,page,page_size}`. `GET /resources/{resource}/{uuid}` reads one scoped row. `POST` creates; `PATCH` updates allowed fields. No hard-delete endpoint exists for academic or attendance history. Use lifecycle statuses. Request fields are the generated Zod schemas; unknown columns, roles and tenant IDs are refused.

Allowed resource names: students, parents, teachers, academic_sessions, classes, subjects, enrollments, student_parents, teacher_class_assignments, exams, marks, assignments, timetable_entries, school_holidays, announcements, fee_records, nfc_cards, device_locations, attendance_rule_versions, notification_preferences. The registry in `modules/school/resources.ts` maps each to permission and scope; it is never derived from an arbitrary SQL identifier.

Create requests accept `Idempotency-Key` (8-200 safe characters). Reusing a key with a different body returns IDEMPOTENCY_CONFLICT; an identical retry returns its committed result. Use UUIDs and retain the same key when retrying after a lost response. Rule versions are immutable; create a new version. A later version closes an earlier open effective range; overlaps are rejected by PostgreSQL. Timetable exclusion constraints prevent double booking. Student and device counts are checked under transaction locks.

Teachers see assigned classes and student rosters; subject writes and academic reports require their assigned subject or class-teacher assignment. Parents see active linked children and published exams only. Student accounts see their own linked student row. Revoked links apply on the next request.

## Operational endpoints

| Method/path                             | Contract / permission                                                                                                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET /attendance?date=YYYY-MM-DD         | Scoped paginated daily register, attendance.read                                                                                                                                                   |
| POST /attendance/manual                 | student_id, date, status, reason, optional expected_version; manual_write; optional Idempotency-Key                                                                                                |
| POST /attendance/bulk                   | class_id, date, reason, 1-500 unique records `{student_id,status,expected_version?}`; manual_write; atomic enrollment/NFC/version checks; optional Idempotency-Key                                 |
| GET/POST /corrections                   | Scoped requests / daily_attendance_id, requested_status, reason                                                                                                                                    |
| POST /corrections/{id}/decision         | `{approve:boolean}`; correct_approve; another reviewer required                                                                                                                                    |
| POST /marks/bulk                        | exam_id and 1-500 `{student_id,subject_id,score,remarks?}`; atomic UPSERT; marks.write                                                                                                             |
| GET /devices                            | Own-school public device metadata; devices.read                                                                                                                                                    |
| POST /devices/claim                     | device_code, claim_code, name, location_id; devices.manage                                                                                                                                         |
| PATCH /devices/{id}                     | name, location_id, ACTIVE/DISABLED/REVOKED status, reason, optional safe config                                                                                                                    |
| POST /invitations                       | existing record_id, matching email/full_name, school role; users.manage; invitation through Supabase Auth                                                                                          |
| GET/PATCH /memberships/{id?}            | List accounts / role and status changes; users.manage; self-change prohibited                                                                                                                      |
| PATCH /school                           | name, IANA timezone, en-IN/hi-IN locale; school.manage                                                                                                                                             |
| GET/PUT/DELETE /school/retention        | Read, approve or disable future opt-in cleanup; school.manage; PUT needs approved=true, policy_ref, report_days and notification_days (7-3650)                                                     |
| GET /lookups/accounts?role=teacher      | Active named school accounts for teacher/parent/student profile linking; users.manage; paginated search                                                                                            |
| GET /devices/{id}/configurations        | Versioned configuration snapshots with reason/editor; devices.read; paginated                                                                                                                      |
| GET /profile/parent                     | Own parent ID/name for notification preferences                                                                                                                                                    |
| POST /fees/{id}/pay                     | amount (positive, up to two decimal places), payment_method, optional note; fees.write; required Idempotency-Key; exact outstanding balance enforcement; identical retries return original receipt |
| POST /fees/{id}/remind                  | Outstanding fee reminder, once daily per fee; fees.write                                                                                                                                           |
| GET /subscription                       | Effective flags/limits/state; subscription.read                                                                                                                                                    |
| GET /audit                              | Paginated append-only school audit summaries; audit.read; optional cursor mode                                                                                                                     |
| GET /notifications                      | Paginated delivery history; active linked parent scope rechecked immediately; optional cursor mode                                                                                                 |
| POST /push-tokens                       | token, WEB/ANDROID/IOS; stored encrypted, lookup hash; parent preferences permission                                                                                                               |
| DELETE /push-tokens                     | token_hash; deactivate this user's current device token                                                                                                                                            |
| POST /materials/upload                  | class_id, filename (PDF/PNG/JPEG); scoped signed upload to private materials path                                                                                                                  |
| GET /materials/{assignment_id}/download | Authorized short-lived private material download                                                                                                                                                   |
| GET/POST /reports                       | Own report list / kind ATTENDANCE/ACADEMIC/FEES, from/to, optional student_id/class_id and format PDF/CSV (CSV requires advanced_reporting)                                                        |
| GET /reports/{id}/download              | 60-second application-signed URL bound to actor, school and report                                                                                                                                 |
| GET /reports/{id}/file                  | Requires the same JWT, membership, report scope, expiry and signature; streams private PDF/CSV                                                                                                     |
| GET /support-grants                     | School administrator reviews time-boxed support requests                                                                                                                                           |
| GET /support-access                     | Own-school active approved support grants for the security notice; users.manage                                                                                                                    |
| POST /support-grants/{id}/decision      | approve boolean; grant revocation is immediate                                                                                                                                                     |

Parents/students must choose a linked/self student when creating reports. Teachers' exports remain assigned-class/subject scoped. Report generation rechecks membership at processing time; downloads recheck it again. URLs are signed at the application boundary and also require JWT authorization, so copying another user's URL does not grant access. Raw storage report URLs are not exposed.

Bulk mark writes validate every row before UPSERT. Invalid enrollment/score returns 422 BULK_VALIDATION_FAILED with `error.details:[{path:['entries',zeroBasedRow,'score'|'student_id'],message}]`; no row is saved. Zod request errors expose `error.issues` with equivalent paths. A successful retry with the same idempotency key returns the original committed result. Academic PDFs summarize recorded subject scores per exam/student using the exam maxima; they do not invent grades or treat missing subjects as zero.

Retention never starts without an approved school policy. Report expiry removes the private generated file before marking its report row EXPIRED; underlying source records remain. Notification pruning affects only old terminal COMPLETED jobs and their delivery records. Pending/dead jobs and application audit history remain available. Disabling the policy stops subsequent cleanup cycles.

## Platform operations

GET `/platform/schools`, `/platform/devices`, `/platform/plans`, `/platform/support-grants` return metadata only through app_platform, which has no student/attendance/fee/mark table privilege. POST `/platform/schools` creates a school plus trial subscription (school_code, name, timezone, plan_code, trial_ends_at); an absent or inactive plan returns 422 and creates neither record. PATCH `/platform/schools/{id}/subscription` saves plan_id (or plan_code), status, current_period_end, grace_ends_at, optional limit_overrides and a required reason. It initializes a subscription if the authorized school has none, and otherwise updates its latest subscription. School-row locking serializes first-time setup; repeated saves reuse the record. Missing schools return 404. Initialization requires an active plan; existing subscriptions may retain their current inactive plan. Omitted overrides/grace dates preserve existing values, while `{}`/`null` explicitly clear them. Every save is audited and recorded in subscription_events; the first event has previous_status=null. No database migration is required for this recovery flow.

POST `/platform/schools/{id}/administrator-invitation` (`email,full_name,resend?`) and POST `/platform/schools/{id}/administrator-invitation/{invitation}/cancel` bootstrap or cancel only the first School Admin invitation. An already staffed/onboarded school cannot use platform bootstrap for routine membership changes. These functions return safe invitation summaries rather than a general account directory. All platform routes require verified MFA.

PATCH `/platform/plans/{id}` takes name, active status, defined feature flags/numeric limits and reason; plan code is immutable. Subscription changes validate the selected plan and known limit names. Omitted overrides/grace fields retain stored values; `{limit_overrides:{}}` explicitly clears overrides. GET `/platform/operations` returns aggregate school/plan usage, report/notification backlogs, quarantine/sequence gaps and private worker state; missing/stale workers are not reported as healthy. Its website route is `/platform/health`.

POST `/platform/devices` takes school_id, device_code, name, hardware_serial. Response includes unique device_secret and claim_code **once** with Cache-Control no-store; database stores only SHA-256 hashes. Never put this credential in web configuration. POST `/platform/devices/{id}/rotate` and `/revoke` require a reason. Rotation overlaps credentials for 24 hours; revocation is checked on every request and every event.

POST `/platform/support-grants`: school_id, reason, ticket_ref, scope array (`students`, `attendance`, `marks`, `fees`), minutes 1-1440. School Admin approval is mandatory. GET `/platform/support-grants/{id}/{feature}` reads up to 100 permitted rows while approved/unexpired. The live grant is revalidated and locked in the same tenant transaction that reads and separately audits every returned record. Revocation prevents the next read and waits for an already authorized read transaction to finish. The browser hides the support view on expiry or failed authorization refresh.

## Manual billing

The owner selected manual billing. The mounted billing webhook is disabled regardless of the legacy adapter secret setting. Super Admin subscription changes require MFA, a reason and, optionally, a billing_ref. Terminal statuses also require an explicit export_until deadline. A school cannot modify these entitlements.

The following is an inactive adapter contract retained for a future owner-selected integration:

`POST /billing/webhook` is not enabled in this release. It is an adapter contract, not a claim of integration with any selected payment vendor. A chosen vendor adapter must verify its vendor signature before transforming to `{id,school_id,status:ACTIVE|PAST_DUE|CANCELLED,current_period_end}`. Send X-Webhook-Timestamp (Unix seconds) and X-Webhook-Signature (hex HMAC-SHA256 of `timestamp + '.' + raw JSON bytes`). The API checks a five-minute replay window and constant-time signature, then applies an idempotent metadata-only database function. Identical event IDs cannot change payloads. Fee payment collection and vendor invoices remain outside SAS v1's selected-provider scope.

## Health and limits

`GET /health/live` is process liveness; `/health/ready` checks database connectivity. Production TLS terminates at Render. The API uses an explicit origin allowlist and verified database TLS. User data is not logged. PostgreSQL-backed HMAC-keyed counters enforce shared user/IP/bulk and device quotas across API replicas. The early in-memory limiter is an additional per-instance guard. Configure public Supabase Auth rate/abuse controls separately. See `docs/DEVICE_API.md` for NFC-specific bodies, per-event commit semantics and firmware behavior.

The Render worker has no public HTTP listener. Its private database heartbeat is checked by `npm run health:live -w @vidyalayaa/worker` and `npm run health:ready -w @vidyalayaa/worker`: liveness requires a recent heartbeat, readiness additionally requires a RUNNING worker with a successful cycle within five minutes. Provider/channel rate buckets are shared in PostgreSQL. Each push token has its own result; invalid tokens are disabled independently, successfully sent targets are not repeated on transient retries, and recipient errors do not trip the provider outage circuit. English/Hindi push messages omit names on the lock screen by default unless the parent changes that preference; email/SMS remain subject to the approved notification policy.

## Audit additions and ownership

| Method/path                                    | Authority and behavior                                                                                                                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET/PUT /school/security | School Admin only. Saves use the current version and require confirmation and verified recovery for stricter MFA. |
| GET /school/security/history and /school/security/audit | School Admin only. Paginated policy history and tenant-scoped security events. |
| POST /account/sessions/activity | Extends the current live session after user interaction and returns its inactivity deadline. |
| GET /analytics?student_id=                     | marks.read; published marks and current class/child/self scope                                                                                                                                             |
| GET /corrections?status=REQUESTED&reviewable=1 | attendance.read; status filter applies before pagination/count; reviewable=1 requires attendance.correct_approve and excludes own requests                                                                 |
| GET /attendance/events                         | attendance.read; scoped immutable movement history, optional date/student/review filter                                                                                                                    |
| GET /attendance/reviews                        | correction approver's reconciliation queue                                                                                                                                                                 |
| POST /attendance/events/{id}/reconcile         | reason; correction approval permission; never rewrites raw timestamp                                                                                                                                       |
| GET /profile/family                            | parent or student; permitted profile and authorized children/self                                                                                                                                          |
| GET/PUT /profile/preferences                   | current parent's no_names_on_lock_screen preference                                                                                                                                                        |
| POST /imports/{resource}                       | users.manage plus resource write; rows (1-500), validate_only; atomic commit and Idempotency-Key                                                                                                           |
| GET /marks/entry-sheet?exam_id=UUID            | marks.write; open authorized exam only; numeric roll-ordered class roster, configured permitted subjects and existing marks; official entry requires Class Teacher or School Admin; at most 5,000 students |
| POST /marks/entry                              | marks.write; exam_id and exactly one entries[] row; normal user/IP rate limits; same authorization, atomic upsert, audit, lock and idempotency checks as bulk marks; rejects multi-row bodies              |
| POST /resources/{resource}/{id}/retire         | resource write; reason; retire/end/cancel without deleting history                                                                                                                                         |
| GET/POST /exports                              | School Admin only; JSON/CSV, reason; at most two pending exports per school                                                                                                                                |
| GET /exports/{id}                              | authorized manifest/files with SHA-256; current export window applies                                                                                                                                      |
| GET /exports/{id}/files/{index}                | private file stream, JWT plus signed ticket, current School Admin/window                                                                                                                                   |
| GET /offboarding                               | School Admin's closure proposal                                                                                                                                                                            |
| POST /offboarding/{id}/approve                 | approve, policy_ref; distinct school approval                                                                                                                                                              |
| GET /usage                                     | own persisted school usage                                                                                                                                                                                 |
| GET /organization/campuses                     | current explicit memberships within the selected Enterprise organization                                                                                                                                   |
| POST /notifications/{id}/retry                 | School Admin, reason; sent push targets stay deduplicated                                                                                                                                                  |
| GET/POST /support-requests                     | school administrative intake, subject/category/description; no implicit support grant                                                                                                                      |
| GET /platform/support-requests                 | MFA-protected metadata support queue                                                                                                                                                                       |
| PATCH /platform/support-requests/{id}          | OPEN/IN_PROGRESS/RESOLVED and response                                                                                                                                                                     |
| GET /platform/notices                          | device/commercial metadata escalations                                                                                                                                                                     |
| GET /platform/audit                            | safe metadata only; no child-record directory                                                                                                                                                              |
| GET /platform/usage                            | persisted per-school usage                                                                                                                                                                                 |
| GET/POST /platform/organizations               | campus group metadata/name                                                                                                                                                                                 |
| PATCH /platform/schools/{id}/organization      | organization_id or null, reason; Enterprise cap; no implicit membership                                                                                                                                    |
| GET /platform/offboarding                      | closure metadata queue                                                                                                                                                                                     |
| POST /platform/schools/{id}/offboarding        | reason, policy_ref, export_until, delete_after; legal hold defaults on                                                                                                                                     |
| POST /platform/offboarding/{id}/close          | confirm=CLOSE_SCHOOL; school approval and drained-reader guard                                                                                                                                             |
| POST /platform/offboarding/{id}/hold           | enabled, policy_ref, reason; explicit hold decision                                                                                                                                                        |
| POST /platform/offboarding/{id}/purge          | confirm=DELETE_SCHOOL_DATA, policy_ref, reason; final export/date/hold guards                                                                                                                              |

Downloads are reauthorized even after URL issuance. Saved report provenance binds school authorization revision, current role and scope fingerprint; a demotion or removed family/teaching link invalidates the old artifact. The worker rechecks the requester before generation. CSV neutralizes spreadsheet formulas and streams in 500-row pages; the 19 MiB output bound fits the private 20 MiB bucket. Material upload remains independently capped and MIME-whitelisted.

School closure/export/deletion uses separate proposal, approval and worker transitions. SUSPENDED/CANCELLED/EXPIRED subscriptions never imply deletion. The School Admin retains billing/support access; a contractual export deadline is mandatory for exports. A closed school cannot queue a normal report that its worker will never process; use full-school exports.

Firmware-specific release metadata is gated and retained for future integration. All embedded development is deferred by the owner; those endpoints do not establish hardware readiness.

## Record-bound invitations

School invitations now require an existing `record_id`, matching email and role. `GET /invitation-candidates?role=...` supplies paginated eligible school records. Acceptance atomically links that exact student/parent/staff record to the verified account; parent-child links and current class assignments scope the resulting data. Principal records are staff records with `staff_role=principal`. See ACCOUNT_ONBOARDING.md for prerequisites, first-administrator exception and migration 023. No roll-number sign-in is added.

## School Admin workflow guarantees

Class registers use the same write service as individual manual attendance: the student must be enrolled in the selected class on that date; the enrollment supplies the academic session; recorded NFC evidence requires a separate correction; expected versions reject stale updates. A failing row rolls back the entire batch and its notifications. The website loads all register pages up to the 500-record bound and preserves retry keys after a lost response. Attendance corrections require another reviewer.

Fee payments require an `Idempotency-Key` of 8–200 safe characters. The key is scoped to the authenticated user and school and fingerprints both the fee ID and payment body. An identical retry returns its original UUID receipt without applying another payment; changed contents return 409. Paid/waived fees and overpayments return 409; sub-cent amounts return 422. The committed receipt, reference, amount and status are retained in append-only audit metadata. This records a manual school payment; it does not charge a gateway.

Reader configuration changes retain a versioned snapshot and an explicit audit reason. `GET /devices/{id}/configurations` returns `reason` for changes recorded by the current API; older snapshots without that event return null. Historical reasons are not inferred. Student overview projections independently enforce fee/card/guardian permissions and the existing assessment subject/publication scope.

## Class and student fee management

The existing fee records now support versioned class/section structures, dated installments, transport assignments and an append-only payment allocation/reversal ledger. Parents and students have read-only ownership-scoped statements and printable receipts. School Admin and record-bound finance staff can collect manual payments; only School Admin can override generated receipt numbers. See [Fee management](FEE_MANAGEMENT.md) for contracts, validation, migration and recovery details. Existing payment endpoints post to the same ledger.

## Account login sessions

Every role can view and end only its own provider-backed sessions using `/account/sessions`. These account routes do not require school selection. Revoked provider sessions are rejected on every subsequent authenticated API request. See [Security & Login Sessions](LOGIN_SESSIONS.md) for API contracts, privacy, notifications, migration and verification details.

## Account email and credentials

`GET /api/v1/account/credentials` returns only the authenticated user's `email`,
`pending_email`, `email_confirmed` and `has_password` boolean. It accepts no user ID
or query parameters. It returns no hashes, passwords or session credentials.
Email and password writes use Supabase Auth's own SDK and verification APIs,
not a privileged administrator password endpoint. Setup, templates and provider
security settings: [AUTH_ACCOUNT_SETTINGS.md](AUTH_ACCOUNT_SETTINGS.md).

## Academic-year promotion

The School Admin preparation, preview, activation and historical-record endpoints are documented in [Academic-year promotion](ACADEMIC_YEAR_PROMOTION.md#api-contracts) and the generated OpenAPI specification. All endpoints remain relative to `/api/v1` and require the existing user authentication and school context.

## School Profile Management

School and platform profile endpoints, administrative privacy, image/policy uploads, Principal delegation and deployment instructions are documented in [School Profile Management](SCHOOL_PROFILE_MANAGEMENT.md). School name, school timings, announcements and existing account permissions retain their established sources of truth.
