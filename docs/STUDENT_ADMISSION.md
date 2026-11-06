# Student admission and class-wise directory

## School Admin workflow

Open **Students → Add student**. One form contains:

1. Student code, first/last name, email, birth date, gender and status. gender accepts Male, Female, Other or Not specified and can also be edited later. Existing students and older imports default to Not specified.
2. Class/section, roll number, enrollment start and optional end date. The server derives the academic session from the selected class.
3. One or two parents/guardians. Enter a new parent's name/email/phone, or explicitly select an existing parent for siblings. Set each relationship, the primary contact and alert eligibility.

**Save student & family** creates the student, enrollment, new parent records and family connections together. Any validation, duplicate, permission, quota or relationship failure rolls back the entire admission. Retry keys prevent repeated submissions creating duplicate records. The new student's full profile opens after success.

Only one primary contact can be selected. Existing parent records are linked without overwriting their details. A new parent email that already exists in this school produces an actionable conflict; select the existing parent instead of merging by name or email automatically. Inactive parents cannot be selected for new links.

Account invitations remain in **Members & invitations**, using the existing record-bound verification workflow. Saving an admission does not create passwords, Auth accounts, memberships, invitations or outbound messages.

## Finding students

The default `/admin/r/students` page groups classes by academic session and grade. Expanding a class displays every section's paginated student roster. Clicking a student name or **Full profile** opens the existing Student 360 view, including parent contacts, current class/roll number, personal details, attendance, academic results, fees and card records within the caller's existing permissions. Student email is now included in personal details.

Current placement requires an ACTIVE enrollment whose start/end dates include today's school-local date and whose class is not archived. Counts and rosters share this rule. All student statuses remain visible; withdrawing a student does not hide their record.

**Not currently enrolled** preserves visibility for students without a current placement, including students with scheduled, ended or archived-class enrollments. A student may appear in more than one session if existing enrollment relationships warrant it; no duplicate student is created.

Search matches student name, code and email across the school. Classes are loaded across batches of 100; rosters load only when their class is expanded and page in groups of 25. Admission pickers support searching when there are more than 100 matches. Session filters, reset, existing student editing and CSV import remain available. The whole student card opens the full profile, with a separate Edit student action.

The old **All student records** button, separate School Admin Parents/Family links navigation, and disconnected entry pages have been removed. Old `?view=records`, `/admin/r/parents` and `/admin/r/student_parents` links redirect to the class-wise Students workspace; student search parameters are retained. Existing parent contact details and family relationships/alert settings can be edited inside the selected student's profile. Underlying records and resource APIs remain intact, and Principal/Teacher/Parent/Student views retain their existing role restrictions.

In the Principal workspace, the former **Parents & Guardians** and **Family Connections** pages redirect to Students. Principals can view linked guardians within each student's profile.

The Students page's CSV import now supports complete admissions, including enrollment, gender, parent details and family connections. Download its template before preparing the file. **Export CSV** downloads full matching student and parent records across all pages. See [student CSV import and export](STUDENT_CSV.md). The older generic record-only import API remains compatible; older unplaced students remain in the unassigned group. Class enrollment management is inside each student's profile, with existing dates, roll numbers, status and history retained. The Student 360 current enrollment no longer selects a future or expired placement as current.

## API

All paths use `/api/v1`, verified Supabase authentication and the selected `X-School-Id` membership. Class and student lists require School Admin or Principal with `students.read`, `parents.read` and `academics.read`. Principal can browse the class-wise directory and open student profiles. Admission lookups, admissions, CSV import and CSV export require School Admin. Admissions also require `students.write`, `parents.write`, a writable subscription and the existing student limit.

| Endpoint | Contract |
| --- | --- |
| `GET /student-directory/classes` | Paginated class/section/session rows, matching student counts and `unassigned_count` |
| `GET /student-directory/students` | Supply exactly one of `class_id` or `unassigned=1`; paginated student records and placement/roll metadata |
| `GET /student-directory/enrollment-classes` | Non-archived class/session choices, labeled with session |
| `GET /student-directory/parents` | Active, same-school parent choices |
| `POST /student-directory/admissions` | Shared `studentAdmissionSchema`; required `Idempotency-Key`; returns `{student,enrollment,parents,connections}` with 201 |
| `POST /student-directory/imports` | Shared CSV admission contract; validate or atomically save 1–500 complete admissions with required commit retry key |
| `GET /student-directory/export.csv` | School-scoped, no-store CSV download with optional search/session filters and full parent details |

GET lists accept `search` (up to 120 characters), `page` and `page_size` (1–100). Body fields cannot override school, session or authenticated account links. Each guardian supplies exactly one of `parent_id` or `parent: {full_name,email?,phone?}`, plus `relationship`, `is_primary_contact` and `can_receive_alerts`. No new `user_id` can be supplied through this form.

Existing non-bypass API database roles, forced tenant RLS, composite foreign keys, unique student codes, unique family links and active-enrollment uniqueness remain authoritative. Student quota checks share the existing student-write advisory lock. New parent email checks share the parent-write lock. New rows receive existing creation audits and family-link database audits. Denied access retains its separate security audit even when the admission itself is rolled back.

## Deployment and verification

The combined admission workflow uses existing tables and RLS. The recorded-gender addition requires the additive migration documented in [STUDENT_GENDER.md](STUDENT_GENDER.md). Apply it before deploying matching contracts, API and web builds. Existing student, parent, invitation, teacher, academic and financial records are retained.

Tests exercise the real Express API and a disposable database with migrations, runtime roles and RLS. External authentication and delivery providers are simulated; live invitations and production writes are not exercised.

```powershell
npx vitest run
npx playwright test tests/e2e/student-directory.spec.ts --workers=1
npm run typecheck
npm run build
npm run contracts
npm run lint
npm run check:secrets
```

Latest combined admission, recorded-gender and Academics verification:

- **182 unit/API/database/security tests passed** across 29 files, including nine admission/directory tests and an upgrade test preserving existing records when gender is added.
- **30 targeted desktop/mobile checks passed in the final run**: combined admission and profiles, gender saving/editing, guardian reuse and duplicate rollback, private drafts, class/section ownership, more than 100 classes, student editing, embedded academic sessions, enrollment history, counts without roster requests, legacy URL redirects, Principal profiles/restrictions and Teacher student/parent access.
- New directory and admission form checks found no serious/critical Axe violations. Viewport-overflow assertions passed, and desktop/mobile directory screenshots were visually reviewed.
- Type checking, source linting, secret scanning and whitespace checks passed. OpenAPI was regenerated from the shared contract.
- The full production build passed for contracts, API, worker and website. Browser fixtures shut down their temporary servers; no permanent development server was started.

### Unified School Admin workflow cleanup — 22 October 2026

The final desktop/mobile run passed **10 checks** covering combined admission, student/parent/connection edits inside the workspace, whole-card and keyboard profile opening, legacy-URL redirects, preserved search, private drafts, more than 100 classes, and accessibility. Additional Principal profile/search, School Admin import/search and school-switching regression checks also passed. Type checking, source linting, secret scanning, whitespace checks and the website production build passed. Temporary test servers were closed. This cleanup changes the frontend only; no API, authorization, database schema or stored records were changed.
