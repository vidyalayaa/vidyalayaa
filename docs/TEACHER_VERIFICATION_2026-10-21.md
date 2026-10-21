# School Admin and Teacher verification — 21 October 2026

## Delivered rules

| Workflow | Enforcement and evidence |
| --- | --- |
| One Class Teacher per class/section | Required Classes & Sections field and shared create schema; API validates an active same-school Teacher profile. A database trigger rejects empty designations on active classes saved by the API role. Existing legacy rows remain intact. |
| Multiple subjects/classes | Separate dated teacher/class/subject assignment rows. A Class Teacher designation is independent of subject assignments. |
| Teacher students and parents | Assigned-class selector, scoped students, active authorized guardian links and profiles. API predicates and restrictive RLS deny unassigned classes and other schools. |
| Manual attendance | Class Teacher only among Teachers, for the designated class and enrolled students. Checks apply to individual writes, atomic register writes, correction requests, direct SQL and replayed idempotency keys. School Admin/Principal permissions remain as previously defined. |
| Subject teacher attendance | View assigned-class records. No marking or correction controls for subject-only classes; forged API and SQL writes are rejected. Raw attendance evidence cannot be deleted. |
| Homework/materials | Exact assigned class and subject required for every Teacher, including a Class Teacher. Designation alone does not grant homework subject access. |
| Subject tests | Exact assigned class and subject required for creating tests and entering/uploading marks. |
| Official main examinations | School Admin manages examinations. Only the designated Class Teacher among Teachers can view the workflow and enter/upload official marks across subjects for that class. Replacement revokes the previous teacher on the next request. |
| Locked/published assessments | Read-only marks views; uploads and individual writes require an OPEN assessment and scores within its maximum. |
| Administrative separation | Teacher navigation and direct page routes reject Academic Administration. API write permissions and database policies independently protect administration records. |
| Exports and account changes | Teacher academic exports apply the same official/subject-test distinction. Suspended membership fails closed; access revisions invalidate older report authorizations. |

## Implementation evidence

- `apps/web/src/features/operations/Teaching.tsx`: roster, subject tests, official results, mark entry and uploads.
- `apps/web/src/lib/use-teaching-classes.ts`: shared assignment/designation query.
- `apps/web/src/features/operations/Screens.tsx`, `ClassAttendanceSheet.tsx`, `features/dashboard/TeacherPortalSection.tsx`: attendance write controls and Class Teacher selection.
- `apps/web/src/features/resources/ResourceScreen.tsx`, `metadata.ts`, `BulkMarksDialog.tsx`: required designation, scoped forms, contextual drafts and CSV uploads.
- `apps/api/src/modules/school/resources.ts`, `router.ts`, `manual-attendance.ts`, `bulk.ts`: API permissions, contextual authorization and validation.
- `apps/worker/src/reports.ts`: export authorization.
- `packages/contracts/src/index.ts`: shared contracts.
- `db/migrations/20261021154148_teacher_subject_authorization.sql`: assessment metadata, indexes, permissions, private authorization helpers, restrictive policies and write guards.

## Executed verification

- Full Vitest suite: **160 passed in 26 files**. Includes existing platform, School Admin, Principal, parent/student isolation, invitation, attendance worker, backup/restore and ownership checks.
- New Teacher API/security tests: **11 passed**, included in the full suite. They exercise ordinary subject teachers, Class Teachers, multiple assignments, unassigned classes, unauthorized guardians, individual/bulk marks, homework, attendance, designation replacement, idempotency replay, direct SQL under `app_api`, suspended membership and actual worker CSV output.
- Legacy migration test passed: existing examination IDs, marks and null-subject assignments remain; historical exams become OFFICIAL; null-subject rows never grant all-subject access.
- Desktop/mobile browser run: **all 44 selected scenarios verified**. The combined run passed 43 of 44, including all 16 new Teacher/assignment cases. One desktop School Admin correction case exceeded its 30-second timeout while loading; its isolated rerun passed in 13.5 seconds. The mobile equivalent also passed. No application fix was needed for this timeout.
- Production builds for contracts, API, worker and web passed. OpenAPI was regenerated from the shared contracts. Type checking, lint, embedded-secret checks and `git diff --check` also passed. Vite emitted an informational chunk-splitting warning because the shared resource form is used by both teaching pages and a lazy route.
- Teacher roster screenshots were visually inspected; automated checks found no serious/critical Axe violations on the Teacher dashboard, roster, subject-test and official-result pages, and no viewport overflow at the tested sizes.

Browser tests run the real website against disposable Express services and a migrated PostgreSQL-compatible PGlite database with the non-bypass runtime roles and forced RLS. External identity/email/storage providers are simulated in the fixtures. No real invitations, payment notifications or school records are created by these tests.

## Configured database and deployment limits

Read-only inspection of the configured database confirmed:

- The Class Teacher and teacher-subject assignment columns exist.
- Its existing class has a Class Teacher.
- All 23 preceding repository migration checksums match the ledger.
- An additional historical `202610190010_firebase_auth.sql` ledger entry is absent from this checkout.
- The new teaching migration has **not** been applied; assessment-kind/subject columns are absent.

No configured database, authentication settings or school data was changed. Production/staging deployment, cloud security/performance advisors, live Auth/Storage delivery and native Safari acceptance were not executed. Mobile coverage uses Chromium with an iPhone viewport.

Before enabling this release against the configured database, reconcile the historical migration with its owner, back up the target, and apply the new migration through the existing checksum ledger. Deploy the matching API, worker and web builds. See [Teacher assignments and deployment steps](TEACHER_ASSIGNMENTS.md). Do not reset or reseed existing school data.

## Commands

Run from the repository root with supported Node 24:

```powershell
npx vitest run
npm run typecheck
npm run lint
npm run check:secrets
npm run contracts
npm run build
```

Browser regression selection:

```powershell
npx playwright test tests/e2e/teacher-management.spec.ts tests/e2e/teacher-workflows.spec.ts tests/e2e/school-admin-workflows.spec.ts tests/e2e/principal-workflows.spec.ts --workers=1 --grep 'Teacher|School Admin (creates, reads and edits (classes|teacher_class_assignments|exams|marks|assignments) |imports marks|marks a class register)|Principal reads (classes|exams|marks|assignments) '
```

Isolated timeout investigation:

```powershell
npx playwright test tests/e2e/school-admin-workflows.spec.ts --project=desktop --workers=1 --grep 'marks a class register and approves a correction' --timeout=90000
```
