# Student profile

Students open **My profile** in the student navigation, or **View my profile** on their dashboard. The dedicated page is `/student/profile`; the old student record list `/student/r/students` redirects here. Administrator student management and all other dashboard sections retain their existing routes and features.

The student dashboard omits Teacher Assignments, enrollment management and Fees. Academic tabs do not link to the two management sections, and direct student page URLs for all three sections show an unavailable page. Other roles retain their existing sections. Class, section and enrollment details remain part of the student's read-only profile. This navigation change does not alter financial records or backend fee permissions.

## Source of truth and fields

`GET /api/v1/student/profile` requires the existing verified login, active school membership, Student role and `students.read` permission. The school comes from the existing checked `X-School-Id` header; the student record is located by its `user_id` matching the verified actor. No user/student ID, search filter or query parameter is accepted. Unlinked accounts receive 404. Writes receive 405. Browser URLs, identity metadata and email addresses do not select a different student's record.

The response includes only these existing fields:

- `students`: student code, names, date of birth, gender, record email and student status.
- The student's own `users.phone`, labelled **Account contact phone**. It is not a separate school-managed student phone field.
- `schools`: school name and school code.
- `enrollments`, `classes`, `academic_sessions`: own class, section, roll number, academic session dates, enrollment dates and status. Current placement requires an active enrollment with applicable dates, non-archived class/session and an applicable academic session in the school's local time. Historical records remain visible as history.
- `student_parents` and `parents`: only active links to active guardian records, showing name, relationship, email, phone and primary-contact designation. A shared parent does not expose siblings' records or links. Revocation/inactivation takes effect on the next API request.

There is no existing student photo, address or separate admission-date storage. These items are labelled **Not recorded**, with an initials placeholder for the photo. No new columns, fake photo, account avatar metadata or fabricated admission dates are introduced. The earliest recorded enrollment is labelled separately from an admission date. Missing dates/contacts remain empty in the response and display honestly in the UI.

## Read-only behavior and corrections

No student selectors, record-management tabs, edit/import/export/invitation actions or direct mutation of official records are available on this page. The current system supports attendance corrections, not general profile correction submissions. The page directs students to contact School Admin for profile changes; it shows a link to the existing attendance-corrections workflow only if that permission is assigned. It does not create a second correction system or grant students additional correction permissions.

## Database security

Migration `20261028164103_student_profile_scope.sql` adds restrictive SELECT and write policies to the existing `students`, `parents`, `student_parents`, `enrollments`, `classes` and `academic_sessions` tables for `app_api`. Student contexts can read only their own profile, own enrollments/classes/sessions and active authorized family links. Students cannot insert, update or delete these official records through the runtime database role. Other role policies, forced tenant RLS, trusted maintenance/support paths and worker/device permissions are retained.

Private boolean ownership helpers use the existing trusted transaction identity and live role/membership checks. One narrowly scoped definer helper avoids recursive RLS over the family/enrollment graph. It returns no profile data, takes no caller identity, fixes its search path and is executable only by `app_api`. No browser database privileges are added. Existing tenant/user and relationship indexes are reused.

## Deployment and verification

Apply migrations before deploying the matching API/frontend; do not reset or seed a real school database:

```powershell
npm run db:migrate
npm run db:verify
npm run build
npm run typecheck
npx vitest run tests/api/student-profile.test.ts tests/database/student-profile-upgrade.test.ts tests/api/parent-workspace.test.ts tests/api/timetable.test.ts
npx playwright test tests/e2e/student-profile.spec.ts --workers=1
```

The migration changes policies/functions only. Upgrade tests compare columns and existing profile, guardian, family, class, session and enrollment rows before and after applying it. Prefer a forward fix; reverting the frontend does not require weakening the database policies. No bulk changes or copies of student records are needed.

Automated checks use disposable PostgreSQL fixtures and real Express/RLS. External authentication is simulated. Browser checks cover desktop/mobile, date-only rendering in a different browser timezone, accessibility, missing details, revoked links, account unlinking and tampered URLs. Tests do not claim a hosted migration, real-user sign-in or production deployment. The Supabase connector currently exposes no projects for this session, so live schema/data cannot be inspected through that connection.

## Verification — 28 October 2026

- Full local unit/API/database/security regression suite: **316 tests passed across 54 files**.
- Final student profile browser suite: **4 tests passed** across desktop and mobile, including accessibility checks, wrong-student URL parameters, historical and missing data, and account unlinking. Desktop/mobile screenshots were reviewed.
- Production builds, TypeScript checks, lint, secret scanning, changed-file formatting and Git whitespace checks passed. The existing non-blocking ResourceScreen chunk/import warning remains.
- The new migration and verification SQL ran successfully in disposable PostgreSQL fixtures. The upgrade check confirmed no changes to existing columns, student records, family links or enrollments. No hosted migration or deployment was performed.
- Follow-up navigation change: **2 desktop/mobile checks passed** for removal of Teacher Assignments, enrollment management and Fees, including direct student URLs and preservation of the read-only profile. Frontend type checking and the production build passed. No database changes were needed for this follow-up.
