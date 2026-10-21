# School Admin website verification — 21 October 2026

Scope: current School Admin website workflows, the supporting API/worker operations, and school/role isolation. Compared the accessible implementation with the extracted architecture specification (`docs/source/architecture-specification.txt`, especially sections 7, 9 and 12) and the existing onboarding/audit documentation. Firmware development and live deployment were excluded. Billing remains manual.

## Executed results

- **104 distinct browser test cases passed** across desktop Chrome and an iPhone-sized Chromium viewport: 78 integrated School Admin cases and 26 existing authentication/onboarding/form regression cases.
- **142 tests passed across all 23 Vitest files**, covering API workflows, database/RLS/ownership, migrations, security, workers and unit behavior. This includes seven new regression tests that initially reproduced the payment, register, card-retry and profile-disclosure defects.
- The regenerated OpenAPI/security contract checks were rerun separately: five passed, already included in the 142 distinct tests above.
- Lint passed for 108 source files. Embedded-secret checks and `git diff --check` passed.
- Production builds passed for contracts, API, worker and website, including TypeScript checks.

The integrated browser count was established across a desktop run with 32 passing cases, a clean 36-case mobile run, a six-case desktop rerun, four additional membership/school-switching checks, and two student search/pagination checks. Two desktop cases overlap between those runs and are counted once. The additional 26-case regression run passed cleanly. Earlier exploratory failures were investigated; genuine defects were fixed, while incorrect test assumptions about accessible button names, number serialization, invitation-table selection and the intentional foreign-school 404 response were corrected in the tests.

## Feature verification matrix

| Area                  | Executed coverage                                                                                                                                                                                      | Evidence boundary                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Dashboard/navigation  | Leadership actions, support shortcut, mobile menu, school-specific navigation and absence of platform-console access                                                                                   | Actual website/API/database                                                                            |
| School switching      | Switch between two explicitly authorized schools; previous school's student records disappear and the new workspace name appears                                                                       | Actual website/API/database and browser cache behavior                                                 |
| Students              | Create, edit, read, desktop/mobile search, filtered pagination/reset, profile with enrollment/guardian/card/attendance/fee information                                                                 | Actual website/API/database                                                                            |
| Parents/family links  | Create/edit/read parents and explicit child links                                                                                                                                                      | Actual website/API/database                                                                            |
| School staff          | Create/edit/read staff, including Principal role/email                                                                                                                                                 | Actual website/API/database                                                                            |
| Academic setup        | Create/edit/read sessions, classes, subjects, enrollments, teacher assignments and timetable entries; reopen date/time fields without losing values                                                    | Actual website/API/database                                                                            |
| Calendar/rules        | Create/edit/read holidays; build and save an immutable attendance rule without a render loop                                                                                                           | Actual website/API/database                                                                            |
| Daily attendance      | Class register, selected date, learner names, versioned updates, correction requests and approval by another reviewer                                                                                  | Actual website/API/database                                                                            |
| Register reliability  | Lost successful response retried with the same key; no duplicate write; all 105 students loaded/saved beyond the first lookup page                                                                     | Actual website/API/database; response loss injected by browser routing                                 |
| Attendance protection | Wrong/missing enrollment, duplicate/empty rows and stale versions rejected; NFC evidence protected; atomic batch rollback and notification deduplication                                               | Actual API/database regressions                                                                        |
| Movement/review       | View suspect movement events, submit reconciliation request, see request and audit record                                                                                                              | Actual website/API/database; event processing itself is covered by API/worker regressions              |
| Assessments/results   | Create/edit/read examinations and marks, upload CSV marks into an open examination, publish results                                                                                                    | Actual website/API/database                                                                            |
| Homework/materials    | Create/edit/read assignments; upload a private material through the signed-upload workflow and download it through the authorized API                                                                  | Actual website/API/database; external object storage simulated                                         |
| Fees                  | Create/edit/read charges, daily reminder queue, partial/final payment, outstanding balance, receipt, print-only receipt view                                                                           | Actual website/API/database; no gateway or physical printer used                                       |
| Payment reliability   | Lost successful response safely retried; original receipt reused; overpayment, waived/paid fees, sub-cent input and missing retry key rejected                                                         | Actual browser/API/database regressions                                                                |
| NFC cards             | Issue/replace/deactivate a student card; exactly one active card; identical issue retry preserves the original card                                                                                    | Actual website/API/database; no reader hardware used                                                   |
| Device management     | Create locations; claim a provisioned school reader, rename it, save/reopen tuning and inspect versioned history/reason                                                                                | Actual website/API/database; no physical device communication                                          |
| Members/invitations   | Invite an existing Principal record; resend/cancel; require an eligible existing record for each documented school-member role; candidate paging does not submit                                       | Integrated website/API/database plus existing controlled-response form tests; outbound email simulated |
| Membership access     | Suspend and reactivate another member, with authorization changing immediately; prohibit changing the acting/last administrator through the tested path                                                | Actual website/API/database                                                                            |
| Support               | Create a support request; approve/revoke a platform support grant; review audit evidence                                                                                                               | Actual website/API/database                                                                            |
| Notifications         | Inspect failed delivery, submit reasoned retry, observe pending state                                                                                                                                  | Actual website/API/database; delivery to a real provider excluded                                      |
| Imports/retirement    | Validate/import student CSV, retain exact validated inputs, archive subject without hard-deleting history                                                                                              | Actual website/API/database plus controlled-response form regressions                                  |
| Reports               | Request attendance, academic and fee PDFs; execute real report-generation functions; download each PDF; generate/download CSV with correct contents/extension                                          | Actual website/API/database/worker functions; object storage simulated                                 |
| School export/closure | Request private export, execute consistent export function, download generated file; explicitly decline a closure request and keep school access                                                       | Actual website/API/database/worker functions; cloud storage/backup restoration excluded                |
| Settings              | Save school profile and refresh workspace identity; persist school security policy; approve and stop future retention cleanup; render subscription features/limits                                     | Actual website/API/database; cleanup worker not run against real records                               |
| Login/session/forms   | School Admin Google sign-in and enrolled MFA; password MFA; scoped memory drafts, unsaved-change warning and expired-session recovery                                                                  | Existing browser tests with simulated Auth/API responses                                               |
| Authorization         | Foreign records and unauthorized school selection denied; School Admin cannot change platform billing or enter Principal/platform portals; database resource-role matrix and RLS regression suite pass | Actual API/database and browser guards; live identity provider simulated                               |

## Corrections

1. Fixed the dashboard's broken support-grant shortcut.
2. Normalized saved SQL dates/times for HTML inputs, so editing a session, enrollment, assignment or timetable no longer blanks valid values.
3. Wait for refreshed record data before closing successful resource/card/payment/reader dialogs; school-profile changes also refresh the active identity/workspace name.
4. Stopped the attendance-rule builder's repeated parent update/render loop.
5. Reworked class registers to load all pages up to the explicit 500-record bound, show learner names, respect enrollment dates, wait for attendance loading/errors, protect NFC rows, carry expected versions and preserve retry keys.
6. Unified individual/register attendance writes. Both enforce enrollment/class/session consistency, NFC correction requirements and version checks. The register rejects empty/duplicate/oversized input, rolls back all changes on failure and queues deduplicated notifications.
7. Made fee payments retry-safe using the existing transactional idempotency store. Reject overpayment/settled/waived/sub-cent requests, calculate balances in integer minor units, issue UUID receipt references and retain receipt/reference/status in append-only audit metadata.
8. Made card-issuance retries return the committed card and serialized replacements per student.
9. Closed the student-profile disclosure path: independent fee/card/guardian permissions and assessment subject/publication scope are enforced by the API, including when a teacher accesses the profile directly. Waived fees no longer inflate outstanding balance.
10. Display the correct PDF/CSV download action and use the correct file extension from the API projection.
11. Retain reader-change reasons in explicit audit events and expose them with configuration history. Old snapshots without those events keep a null reason rather than an invented history.
12. Explain why an author cannot approve their own attendance correction; keep the backend's separate-reviewer enforcement.
13. Added receipt-only print styling and wrapping for long receipt references on mobile.

The shared request schemas and generated OpenAPI/API documentation were updated. **No new SQL migration is required by these fixes**; the tested environment contains all 23 existing repository migrations. Existing Super Admin corrections and pre-existing academic navigation/validation edits were preserved.

## Reproduction

Use Node 24.12 or newer within major version 24, installed repository dependencies and Playwright Chrome. Run from the repository root. Leave `NATIVE_FIXTURE_DATABASE_URL` unset; the integrated browser fixture rejects it to enforce disposable databases.

```powershell
npx playwright test tests/e2e/school-admin-workflows.spec.ts --workers=1
npx playwright test tests/e2e/record-invitations.spec.ts tests/e2e/school-workflows.spec.ts tests/e2e/audit-workflows.spec.ts tests/e2e/google-login.spec.ts --workers=1 --grep 'School Admin|Invitation cannot|Paging through|school record drafts|expired sessions|Google login preserves school_admin|email/password'
npx vitest run
npx tsx scripts/openapi.ts
npx vitest run tests/security/contracts.test.ts
npm run build
npm run lint
npm run check:secrets
git diff --check
```

The first command runs the final 39-case integrated specification on both viewports (78 cases). During this task the final equivalent coverage was established using the runs described above, rather than claiming a single clean 78-case run. Focused reruns used:

```powershell
npx playwright test tests/e2e/school-admin-workflows.spec.ts --workers=1 --project=desktop --grep 'marks a class|records partial|cannot cross schools|claims, renames|invites an existing Principal|downloads CSV'
npx playwright test tests/e2e/school-admin-workflows.spec.ts --workers=1 --grep 'suspends and restores|school switching clears'
npx playwright test tests/e2e/school-admin-workflows.spec.ts --workers=1 --grep 'searches students, pages'
```

## Limits and release notes

Integrated tests use the actual Express application, all existing migrations, runtime database roles and RLS in disposable PGlite (PostgreSQL compiled to WebAssembly). The report/export checks call the real worker functions; external Supabase identity, email and object storage are simulated. The 26 existing browser regressions also use controlled API responses. They do not certify live Google, SMTP, MFA-provider or cloud-storage connectivity.

No real invitation/notification was sent, no bank/card charge was made, no production data/schema was changed and no cloud deployment was performed. Firmware, OTA/physical-reader behavior, actual printers, multi-connection production concurrency, assistive-technology review and cloud performance/recovery remain separate acceptance work. Test servers are temporary; no configured persistent development server is started by this task.

Deploy matching website and API builds together. The payment API now requires the retry key already supplied by the updated website. An old or separately deployed API/database may still behave differently; these results apply to this checkout and its complete migration set, not automatically to a running cloud service.
