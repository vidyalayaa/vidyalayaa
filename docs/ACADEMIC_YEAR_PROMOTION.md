# Academic-year promotion

School Admin → Academics → **Academic-year promotion**.

## What the workflow does

1. **Prepare a year.** Choose the current open source year and create a later year, or select a later empty year. Preparation leaves the current year, students, fees and accounts unchanged. It creates a resumable preparation record.
2. **Carry forward configuration.** New classes/sections retain their designated active Class Teachers. Optionally copy subjects/subject teachers, class timetables and the latest grade/section fee structures. School-wide period/break settings stay unchanged. Target classes already configured manually can be retained by turning the copy options off. Timetable copying requires the timetable entitlement and management permission.
3. **Map classes and exceptions.** Map each source class/section to its destination. Numeric next-grade/same-section matches are suggested and remain editable. Select individual outcomes: promote, repeat grade, graduate, transfer out or withdraw. Exceptions require a reason. Choose retained or regenerated roll numbers; duplicates against other incoming pupils and existing new-year admissions are blocked.
4. **Review.** Preview exact pupil outcomes, new installment totals, existing unpaid balances, blockers and warnings. Select the target class's immutable fee-plan version. Exception-only destinations use their latest available target-year structure. If fees are disabled, the preview explicitly says no new fees will be assessed.
5. **Activate.** Type `ACTIVATE` after reviewing. The date must be within the target year, after the source year ends, and no later than today in the school's timezone. Future years can be prepared now; return to activate them when due. Activation is an explicit manual action, not a scheduled job.

Activation atomically ends source-year enrollments, creates destination enrollments for promoted/repeating pupils, optionally assesses the reviewed pupils' new-class fees, closes the source academic year and makes the destination current. A failed validation or fee write rolls back the entire activation. Retrying a completed identical plan returns its existing result without duplicating enrollments or charges.

## Preserved identities, records and fees

- Student IDs, login accounts, student codes, parent accounts and family links are retained. New enrollments point to the existing student records.
- Teachers remain assigned to their class/section; pupils move into the destination class's configuration. Review copied staff assignments before activation, especially staff who will leave the school.
- Attendance, marks, examinations, homework, submissions, timetable history and old enrollments stay associated with their original class and academic year. Historical records are not moved into the new class.
- Graduation/leaving is recorded as a transition outcome, and the old enrollment ends. The student's global profile and login are not silently disabled; historical records and outstanding fees remain accessible. Any later account suspension is a separate existing administrative action.
- Existing fees, receipts, payments and unpaid balances remain in their original ledger/year. Historical outstanding balances can still be collected through the existing Fees workflow.
- Fee copying creates templates only. Activation generates selected tuition/other recurring charges once for promoted/repeating pupils. Separately admitted destination-year pupils are excluded from promotion assessments.
- Admission charges are excluded from automatic copying. Transport contracts are year-specific and are not automatically renewed; use the existing Fees module to configure the new service. Old debts are never duplicated as a new charge.
- Homework, examinations, study materials and attendance records are not cloned. School-wide timetable timing settings are reused; optional class timetable copies are independent year-specific entries.

## View another academic year

Use **View academic-year records** on the same page. Select the year, optionally select a class/section, then choose Students, Attendance, Results, Homework, Subjects & teachers, Timetable, Fees or Payments. Tables are paginated. Year selection is local to this read-only view and does not activate a year, change enrollments, generate charges or change the rest of the website's active-year context.

Closed academic years reject academic writes in the database, including direct API attempts. The Academics page labels closed sessions and hides their editing controls. The historical financial ledger remains available for authorized collections and payment reversals through existing workflows.

## Permissions and concurrency

- Only a School Admin with academic, student, teacher and fee management permissions can prepare or activate. Read-only review/history also requires the corresponding read permissions. Principal, teacher, parent, student and platform-only accounts cannot promote pupils or inspect the private transition ledger.
- Existing authentication, MFA, subscription/write controls, school selection and database runtime roles remain in use. All promotion queries include school scope. The transition table uses forced RLS and denies direct browser/PostgREST access.
- Preview confirmation expires after 15 minutes and is HMAC-bound to the current administrator, school, complete plan and source/destination snapshot. Changed enrollments, fee headers, class/staff configuration or timetable settings require a new preview. Tokens and pupil drafts are not persisted to browser local/session storage.
- Activation locks the preparation record, source/target years and affected student/fee/staff records. Database academic-write triggers take a shared parent-year lock, serializing concurrent admissions/configuration with activation. The narrowly scoped `app.lock_academic_year` definer helper checks the runtime school context, exposes only the closed/open result and has a fixed search path. Worker/device roles gain no general academic-year update rights.
- Timetable teacher conflicts are constrained within each academic year, so preserving an old schedule does not block the same teacher's new-year schedule. Conflicts inside the same year remain blocked.

## API contracts

All paths are relative to `/api/v1`, require the existing user bearer token and `X-School-Id`, and are School Admin-only. Shared request schemas live in `packages/contracts/src/promotion.ts`; generated definitions are included in `docs/api/openapi.json`.

| Method | Path                            | Contract                                                                                                            |
| ------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| GET    | `/promotion/workspace`          | Years, classes, runs, fee-plan versions, school-local today                                                         |
| GET    | `/promotion/:id/students`       | Active source-year pupil enrollment roster                                                                          |
| POST   | `/promotion/prepare`            | `prepareYearSchema`; required `Idempotency-Key`; returns prepared run                                               |
| POST   | `/promotion/preview`            | `promotionPlanSchema`; returns outcomes, fees, old balances, warnings/blockers, confirmation token                  |
| POST   | `/promotion/activate`           | `{ plan, token, confirmation: "ACTIVATE" }`; atomic stored result                                                   |
| GET    | `/promotion/history/:sessionId` | `section=students\|attendance\|results\|homework\|subjects\|timetable\|fees\|payments`, optional `class_id`, `page` |

## Deployment and verification

Use the same checked-out revision for migrations, API and frontend. The independent worker setup is unchanged. No new environment variable or email provider is needed; confirmations use the existing server-only `TOKEN_ENCRYPTION_KEY`.

```powershell
npm ci
npm run build -w @vidyalayaa/contracts
npm run db:migrate
npm run db:verify
npm run typecheck
npx vitest run tests/api/promotion.test.ts tests/api/fees.test.ts tests/api/timetable.test.ts
npx playwright test tests/e2e/academic-year-promotion.spec.ts --workers=1
npm run contracts
npm run build
npm run lint
npm run check:secrets
```

Migration `20261101093155_academic_year_promotion.sql` adds the transition ledger and `closed_at`, backfills the timetable's year from its existing class and installs the year guards. The timetable backfill changes its technical `updated_at` timestamp; lecture contents, IDs and creation dates are retained. It does not promote pupils, create fees, close years or change the current year. Apply it before releasing the matching API/frontend. Retain normal database backups and perform the first actual promotion in staging with representative data.

Tests use isolated PostgreSQL-compatible databases and simulated provider identities. Browser tests exercise the actual Express routes, runtime database roles and RLS on desktop/mobile. They do not activate a real school year, test production load, or send real email/notifications. A local PGlite fixture has one connection; true multi-connection lock contention requires the existing native PostgreSQL integration environment.

## Recovery and rollback

Before activation, a prepared year can be resumed and edited through the existing class/fee/timetable screens, then previewed again. Preparation itself never changes pupil enrollments. Do not delete years or manually reset a completed transition to retry it.

After activation, completed transition evidence and old-year academic records are intentionally immutable. Financial receipts must never be erased to undo a promotion. For a mistaken individual destination, use an audited enrollment correction in the current year after assessing fees; do not perform a second bulk activation of the old source year.

For a release rollback, stop promotion writes and keep the additive migration in place while restoring a previously reviewed application revision. Do not blindly drop the timetable year column or restore the previous teacher conflict constraint after new-year schedules exist: retained schedules can legitimately overlap across years. If a whole erroneous activation must be undone, isolate the school, retain all audit/financial evidence and use a reviewed forward correction or restore a verified pre-activation backup into a separate environment before planning recovery. There is no destructive automatic “unpromote” button.

## Verification performed on 1 November 2026

- Nine promotion API/database cases passed, covering role/school isolation, configuration preparation, exact fee previews, tampered/stale confirmation, separately admitted pupils, rollback on failed fees, repeat/graduation outcomes, safe retries, historical read-only records and old-balance collection.
- The full existing unit/API/security/database run checked 379 cases. Initially 377 passed; two upgrade assertions required adjustment for chronological dependency loading and the newly backfilled timetable metadata. Both corrected upgrade cases passed in a focused rerun. The entire 65-file suite was not rerun after these test-only adjustments.
- Forty-two distinct desktop/mobile browser cases passed across the promotion (10), Academics (16), Fees (6) and Homework Diary (10) suites. The older homework button assertion was updated to the current diary label. Academics and Fees were also rerun independently because their worker-scoped test data must not be mixed.
- Production builds for API, worker and frontend, TypeScript checks, lint, generated API contracts, secret checks and Git whitespace checks passed. Existing bundle-size/code-splitting warnings remain informational.
- The connected database migration and schema verification passed. Before/after record counts and current-year selections matched; there were zero promotion runs and zero closed years. No real pupil promotion, fee assessment or provider email was executed.
- Native multi-connection contention, external hosting deployment and authenticated production acceptance were not executed in this change.
