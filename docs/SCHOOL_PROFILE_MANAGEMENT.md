# School Profile Management

## Open the profile

- **Super Admin:** Platform → Schools → **School profile** on the desired school. The complete profile and official school timings can be viewed and managed across registered schools without requesting access to student records.
- **School Admin:** **School information** in the workspace sidebar, or Settings → **School profile**. Choose **Edit school profile** to save full or incomplete information. The completion checklist highlights missing required details.
- **Principal:** The same School Information page shows school and administrative information. Editing is disabled by default. School Admin or Super Admin can explicitly authorize Principal profile editing using the checkbox in Administrative information, and revoke it later.
- **Parents, students and other school staff:** School Information shows official school information, the school logo/gallery, applicable announcements and published policy documents. Management contacts, internal emergency contacts, internal policies, completion details and delegation controls are excluded.

An unassigned account cannot read a school's profile by entering its ID. School selection is resolved through the existing active membership and session verification. The existing suspended/offboarded-school access rules remain in force.

## Information supported

The profile includes school identity, motto/tagline, description, establishment year, school type, address, school email, website, official phone numbers, Principal name/qualifications/office contacts, board, affiliation, recognition, registration/UDISE reference, recognition validity, grades, medium, curriculum, office/visiting hours, facilities, infrastructure, accessibility, transport information, emergency contact/instructions and important school policies.

The restricted administrative section includes the management organization, contact person, email, phone, address, internal emergency contacts and internal policies/management notes. Use official contacts in the sections visible to families.

School name and timezone continue to use the original school columns. Language continues to use the existing school locale setting. School days, lectures and breaks come from the existing timetable configuration. The profile does not create another timing system or duplicate announcements, classes, people or school records.

Creating a school in the platform console retains the required school code, name, timezone, subscription plan and trial deadline. The form additionally accepts basic email, phone and address information; School Admin can complete remaining information later. Existing provisioning clients can continue submitting the original required identity fields.

## Saving and completion

The server accepts incomplete profiles. Empty optional fields remain empty; no placeholder school information is inserted. Invalid email addresses, unsafe website schemes, invalid phone formats, recognition dates and unknown request properties are rejected.

The completion checklist measures 21 required items: school name, logo, description, street address, city, state/region, postal code, country, official email/phone, Principal name, management organization/contact number, board, affiliation or recognition reference, grades, medium, configured school timings, facilities, emergency phone and school policies. Progress is recalculated from saved data and currently published assets.

Profile saves update public information and restricted administration together in one transaction. A server-controlled version and school row lock prevent stale forms from overwriting another administrator's changes. Logo/image/policy changes also advance the profile version. A stale form keeps its local edits and asks the user to refresh/review the current record. Unsaved edits have the existing navigation warning.

Principal authorization applies to active Principal memberships in that school and to this profile only. It grants no academic administration, timetable editing, account management or access to other schools. School timing changes remain School Admin or Super Admin-only.

## Logos, images and policy PDFs

- One current logo, up to 12 gallery images and 20 policy documents per school.
- Logos/gallery accept PNG, JPEG and WebP images up to 5 MB. Policies accept PDFs up to 10 MB.
- The API checks file size, declared MIME type and identifying bytes; SVG, HTML and MIME-spoofed uploads are rejected. This is file-type validation, not malware scanning.
- The existing private `school-documents` bucket is reused. Its existing MIME types are retained and WebP support is added. No public bucket or browser Storage policies are introduced.
- Uploads go through the authenticated API. Server-generated paths follow `<school_id>/profile/<generated_id>.<extension>`; client filenames and paths cannot choose another school or overwrite arbitrary objects.
- Each image/download request revalidates the existing login session and school access. The browser receives image blobs; service-role keys and private storage paths are not exposed in the profile response. PDF responses use attachment disposition.
- Logo replacement and file removal retire the old metadata. Retired assets stop being downloadable through the profile API. Historical objects remain available for authorized school export/backup and the existing retention process; removing an asset does not physically erase its bytes.
- Storage upload failure leaves no published metadata. If a subsequent database operation fails, the newly uploaded orphan is cleaned up where Storage is available. Original profile data remains unchanged.

## Database and permissions

Migration: `db/migrations/20261101131616_school_profile_management.sql`.

The existing `schools` row is the profile root. It gains `profile` (publicly relevant school information) and `profile_version`. `school_profile_private` is a one-to-one restricted section, keyed by the same school ID. `school_profile_assets` contains the profile's image/document metadata. Existing school IDs, settings, names, academic data, accounts, people, family links and financial records are preserved by the additive migration.

Both new tables force RLS. Direct browser/PostgREST access is denied. School profile functions are invoker functions with fixed search paths, not privileged data-bypass helpers. Public profile fields are checked separately from administrative fields. Only School Admin or explicitly authorized Principal can update the school profile through the school API; only School Admin/Super Admin can change delegation. Stable asset identities and one-current-logo uniqueness are enforced in the database.

Super Admin uses the existing platform database role and MFA gate. This adds access to school profile information, not student data. The existing School Admin export includes the public profile, restricted administrative section, asset metadata and associated files. Worker read policies require a school-scoped SYSTEM context with a running export job; user-facing APIs retain their own role policies.

Audit events record profile/timing/asset changes and the affected fields without placing contact values or uploaded file contents in request logs. Existing database backups include the profile tables and their policies.

## API

Paths are relative to `/api/v1`. The school path requires the existing authenticated session and active school context. Platform paths require Super Admin and MFA. Request schemas are shared by frontend/backend in `packages/contracts/src/school-profile.ts` and generated into `docs/api/openapi.json`.

| Method | School endpoint              | Platform endpoint                                | Purpose                                                                           |
| ------ | ---------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------- |
| GET    | `/school-profile`            | `/platform/schools/:schoolId/profile`            | Role-appropriate profile, completion and asset metadata                           |
| PUT    | `/school-profile`            | `/platform/schools/:schoolId/profile`            | Version-checked profile save, including restricted administration when authorized |
| PUT    | `/school-profile/timings`    | `/platform/schools/:schoolId/profile/timings`    | Existing school timing configuration with expected timing version                 |
| POST   | `/school-profile/assets`     | `/platform/schools/:schoolId/profile/assets`     | Multipart `kind`, `title`, `file` upload                                          |
| GET    | `/school-profile/assets/:id` | `/platform/schools/:schoolId/profile/assets/:id` | Authorized current image/PDF bytes                                                |
| DELETE | `/school-profile/assets/:id` | `/platform/schools/:schoolId/profile/assets/:id` | Retire a profile asset                                                            |

`PUT` profile accepts `expected_version`, `name`, `timezone`, `locale`, `details`, optional `administration`, and optional administrator-only `principal_edit_authorized`. It accepts no school-code change, subscription change, arbitrary settings, storage path, role or user ID. A school-scoped request cannot select a different school in its body.

## Deployment

No new environment variables, authentication provider or paid service are required. The API continues using the existing Supabase server Storage client. Apply the additive migration before publishing the matching API/frontend; deploy the worker revision too for complete school exports.

```powershell
npm ci
npm run build -w @vidyalayaa/contracts
npm run db:migrate
npm run db:verify
npx vitest run tests/api/school-profile.test.ts tests/database/school-profile-upgrade.test.ts tests/api/school-export.test.ts tests/api/timetable.test.ts
npx playwright test tests/e2e/school-profile.spec.ts --workers=1
npx playwright test tests/e2e/implicit-school-profile.spec.ts --workers=1
npm run typecheck
npm run contracts
npm run build
npm run lint
npm run check:secrets
```

The migration starts existing school profiles empty and incomplete. It does not infer management details, set fabricated contacts, delegate Principal access, send notifications, change school timings or rewrite school records. Administrators fill the actual information through the new page.

For an application rollback, retain the additive schema and restore the previous application release. Do not drop populated profile tables or storage objects as a routine rollback. Use a reviewed forward correction or verified isolated backup restore for data recovery. Restore the matching worker alongside an application rollback if export behavior changes.

## Verification limits and troubleshooting

Verified on 1 November 2026: all 14 profile API/security cases and the legacy-data upgrade case passed. Related role, invitation, parent/student, timetable, promotion, export, restore and request-context suites were also exercised successfully. All 18 focused desktop/mobile browser cases passed: 12 profile role/workflow cases, two Settings/name-refresh checks, two parent-workspace checks and two school-registration/invitation checks. API, worker and frontend production builds, TypeScript checks, lint, secret checks and Git whitespace checks passed. The existing bundle-size/code-splitting warnings remain informational.

The connected database migration and schema verification passed. A before/after hash of all original school fields/settings and record-count comparison matched. The migration created no administrative profile rows, uploaded no files and changed no real school information. External hosting deployment and a live provider/storage acceptance test were not performed.

API/database tests use real PostgreSQL-compatible fixtures with the existing non-bypass runtime roles. Browser tests exercise actual API requests, storage adapters, UI and RLS with simulated provider identities. These tests do not send email, edit real school information, verify live provider delivery, perform malware scanning or establish production load capacity. Native multi-connection load tests require the existing isolated PostgreSQL integration environment.

The single-school browser regression also covers profile saves, logo upload/removal and school timing saves when the server automatically selects the user's only membership. Request guards use the actual browser school selector (which can be empty), while the displayed school uses the server-resolved school ID. Account and school-switch checks remain active. The frontend correction requires no additional migration.

Save-check correction verified on 1 November 2026: both single-school profile browser cases passed, followed by six desktop/mobile profile and implicit marks-entry regression cases. All seven request-context unit cases and the workspace TypeScript checks passed. These checks used isolated fixture records, with no changes to live school information.

- **Profile changed:** Another profile/file change advanced its version. Review the current profile before resubmitting your edits.
- **Read-only Principal:** An administrator must explicitly authorize profile editing; timetable administration remains separately restricted.
- **Image/document unavailable:** Check Supabase Storage availability, the private bucket, MIME configuration and the server Storage credential. A retired file is intentionally unavailable through the profile API.
- **Permission denied / suspended school:** Preserve the existing membership, MFA, subscription and offboarding rules. Do not disable RLS or switch browser calls to a service-role key.
- **New fields missing after deployment:** Confirm the migration and matching API/frontend revision were released together, then refresh the page.
