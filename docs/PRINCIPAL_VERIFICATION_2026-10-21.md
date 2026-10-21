# Principal website verification — 21 October 2026

Scope: Principal website workflows and their supporting API, SQL, authorization and report-worker behavior. Requirements were checked against the architecture specification in `docs/source/architecture-specification.txt`, especially sections 7.2–7.3, the role layouts in section 9, the correction workflow, and the subscription access matrix. `docs/AUDIT_IMPLEMENTATION.md`, `docs/REMAINING_FEATURES.md` and the existing School Admin verification were also inspected.

## Executed results

- All **148 Vitest tests across 24 files passed**, including six new Principal API/database regressions.
- **102 distinct browser checks passed**: 78 integrated Principal checks (39 workflows on desktop Chrome and mobile Chromium), 14 shared authentication/MFA/invitation checks, and 10 School Admin regression checks for shared screens.
- Production builds passed for contracts, API, worker and website. TypeScript checks passed. Lint passed for 108 source files; the embedded-secret check, focused formatting check and `git diff --check` passed.
- Axe scans on the Principal dashboard, student list, corrections, devices, reports and settings found no serious/critical findings for the selected WCAG 2 A/AA and 2.1 AA rules. Desktop/mobile screenshots were visually inspected. These checks do not replace manual assistive-technology acceptance.
- Temporary browser/API test services were closed. A final listener check found no server on ports 4000, 5173, 5187 or 5188.

Browser totals are deduplicated across several verification runs. The 78 Principal checks include a clean 38-case mobile run, desktop checks and targeted reruns, plus the added draft/schedule/archive test on both viewports. The shared regression run passed 33 cases with the desktop search selector pending; the corrected search and draft/schedule/archive checks subsequently passed in a four-case final run. Profile tests were strengthened with actual academic and fee rows and passed on both viewports. Earlier fixture failures involved missing required fields, an excessive page size, GET request bodies, an incorrect expected import response status, and ambiguous selectors. These were corrected and the affected checks rerun; they are not reported as production defects.

## Principal feature coverage

| Area                 | Workflow exercised                                                                                                                                                                                                             | Evidence boundary                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Dashboard/navigation | Leadership shortcuts, student totals, device health, school-wide academic analytics and role-specific navigation                                                                                                               | Actual website/API/database                                                                           |
| Records              | List and open details for students, parents, staff, sessions, classes, subjects, enrollments, family links, teaching assignments, exams, marks, homework, timetable, calendar, fees, NFC cards, locations and attendance rules | Actual website/API/database; generated records                                                        |
| Search/pagination    | Filter students, page filtered results, reset search/page                                                                                                                                                                      | Actual website/API/database                                                                           |
| Student profiles     | Enrollment, guardian, NFC card, attendance, academic and fee sections; administration actions unavailable                                                                                                                      | Actual website/API/database                                                                           |
| Attendance           | Daily register and class/date filters; classroom marking stays restricted to authorized roles                                                                                                                                  | Actual website/API/database                                                                           |
| Corrections          | Request a correction; reject self-approval; approve/reject another person's request; verify resulting attendance                                                                                                               | Actual website/API/database                                                                           |
| Review queue         | Accurate full pending count, including requests behind newer terminal records; exclude own requests; status and reviewer filters                                                                                               | Actual website/API/database and focused API regression                                                |
| Movement             | View quarantined movement history and request reconciliation                                                                                                                                                                   | Actual website/API/database; generated event evidence                                                 |
| Announcements        | Create/edit/read SCHOOL, CLASS, PARENTS and STAFF publications; draft, future scheduling, early family visibility prevention and archival                                                                                      | Actual website/API/database; recipient/publication behavior also covered by existing API/worker tests |
| Devices              | Read device health and saved reader configuration/history; prevent device writes                                                                                                                                               | Actual website/API/database; no physical reader                                                       |
| Reports              | Generate attendance, academic and fee PDFs/CSVs; download private report bytes; deny another account's report download                                                                                                         | Actual website/API/SQL/report worker; object storage simulated                                        |
| Study materials      | Download private learning material; deny Principal uploads                                                                                                                                                                     | Actual website/API/database; object storage simulated                                                 |
| Notifications        | Read school notification history; deny administrative delivery retries                                                                                                                                                         | Actual website/API/database; external delivery simulated in existing worker tests                     |
| Settings             | Read school name, timezone, language, subscription and account security; hide school administration controls                                                                                                                   | Actual website/API/database                                                                           |
| Role restrictions    | Block other role portals, members, school exports, audit, support authorization, school security/profile edits, fees/cards/device mutations, manual attendance and record writes                                               | Actual website and direct API requests                                                                |
| School isolation     | Reject foreign-school selection, foreign student/detail/analytics access and role-header spoofing                                                                                                                              | Actual API/database and non-bypass tenant role/RLS                                                    |
| Access changes       | Enforce Principal MFA policy, revoke suspended membership immediately, allow reads but reject writes under SUSPENDED_READONLY                                                                                                  | Actual API/database; Auth provider simulated                                                          |

The Principal is intentionally read-only for school administration, academic records, fees, cards and device management. The architecture permits announcement publishing, correction request/review and report export. Disabled or absent School Admin controls are expected role restrictions.

## Fixes

1. The leadership banner counted only the first ten correction records, including its author's requests. The API now validates and applies optional status/reviewer filters before counting/pagination, and the dashboard uses the scoped total. Review links open the matching filtered queue.
2. Correction reviews now show the student number, attendance date and current/requested status. Decision buttons prevent repeated submissions while a decision is being saved, and counts refresh after the save.
3. Principals can open reader settings and saved configuration history in a disabled, read-only form. Backend device-management checks remain enforced; School Admin retains its editing controls.
4. Settings exposes the school profile information already authorized in `/me` as read-only details.
5. Student profile navigation wraps on narrow screens, and wide academic/fee tables can scroll horizontally. The correction status filter has an explicit accessible name.

The API documentation and generated OpenAPI now describe correction filters. These source changes require no new SQL migration.

## Reproduction

Use the repository-supported Node 24 runtime, install dependencies, then run:

```powershell
npm run build -w @vidyalayaa/contracts
npx playwright test tests/e2e/principal-workflows.spec.ts --workers=1
npx vitest run
npm run build
npm run lint
npm run check:secrets
git diff --check
```

The browser fixtures start and close temporary local services. Do not set `NATIVE_FIXTURE_DATABASE_URL`: the integrated browser fixture deliberately refuses a persistent database. No configured website/API/worker is required.

## Limits

Tests use an isolated PGlite PostgreSQL engine with all 23 repository migrations, actual Express routes, non-bypass runtime roles and forced RLS. Supabase Auth, outbound email and external object storage use test adapters; they do not prove real OAuth, SMTP, factor recovery, managed PostgreSQL/pooler behavior or cloud Storage delivery. No real invitation, account, school record, migration or deployment was changed. Live school acceptance still requires the configured Supabase migrations, provider credentials and real Principal account journeys. Mobile checks use an iPhone-sized Chromium viewport; native Safari, manual screen-reader review, cloud load/security acceptance and physical NFC hardware remain separate.
