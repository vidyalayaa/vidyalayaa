# Class-wise School Admin Academics

School Admin → **Academics** opens `/admin/academics`. Classes are grouped by academic session and grade, with each section beneath its class. Expand a section to manage subjects, subject teachers and its Class Teacher, and see student counts by recorded gender. Individual student records and enrollment management belong to Students. Other roles retain their existing workspaces.

## Source of truth

- A `classes` row already identifies the academic session, grade and section. Its `class_teacher_id` is the single Class Teacher designation.
- `subjects` is a school-wide catalogue. A section's configured subjects are the distinct subjects referenced by its non-archived `teacher_class_assignments`, joined to non-archived catalogue subjects. No new class-subject table or copied subject records are created.
- A class subject can have multiple assigned teachers. Historical catalogue subjects already mapped to multiple sections remain intact, while the class subject form excludes subjects belonging only to a different class/section. A subject appears once per configured section with its teacher-assignment rows beneath it. Dates and inactive teachers remain visible for management.
- Enrollment totals come from `enrollments.class_id`, with the matching school and academic-session relationships preserved. Only active students with dated active enrollments on today's school-local date contribute. Each section returns `student_count`, `male_count`, `female_count`, `other_count` and `unspecified_count`. The four categories sum to the total. Existing students default to NOT_SPECIFIED; no gender is inferred from a name. Academics does not fetch or display individual student rosters.
- Preserved legacy assignments without a subject appear in **Assignments needing a subject** within their own section. Repair updates the existing row; archive preserves its history.

## Management

Use **Add class & section** or the class's **Add section** action. Existing forms enforce the required Class Teacher and unique session/grade/section relationship. Edit the class/section or designate its Class Teacher inside the expanded section.

**Add subject & teacher** is a single form inside the selected section, defaulting to a new class subject. Enter the new subject's school-unique code/name, choose its required teacher and save once. Existing choices are limited to this section's own subjects (including its history) and legacy catalogue records with no class assignment. A subject belonging only to another class is excluded and is rejected by the section API if its ID is submitted manually. The backend saves the subject and dated teaching assignment in one transaction. An invalid teacher rolls back the new subject; cancelling saves neither record. Each section has its own subject assignments, enrolled students and Class Teacher. Existing historical shared mappings are preserved rather than copied or deleted.

Editing a subject's code/name affects that shared catalogue record across sections, as stated in the form. Archive individual teacher assignments to remove their teaching relationship from this section, without deleting the catalogue subject or another section's assignment. Existing database uniqueness checks reject duplicate subject codes and duplicate teacher/class/subject assignments.

Use **Students → student profile → Class enrollments** to add/edit class, session, dates, roll number and status, including future or ended records. End an enrollment by changing its status to ENDED. Active enrollments still prevent class archival. Archival never deletes student, enrollment, subject or assignment history.

**Academic sessions** expands management inside this workspace; add, edit and archive actions use the existing forms and resource APIs. School Admin's legacy session/class/subject/teacher-assignment URLs redirect here; legacy enrollment URLs redirect to Students. Principal and Teacher navigation are unchanged. The separate generic academic resource tables are no longer entry points for School Admin.

## API and permissions

All paths use the existing `/api/v1` base, verified authentication and selected school context. The new aggregation endpoints require the School Admin role and academic/student/teacher read permissions; they do not grant additional write permissions.

| GET path | Result |
| --- | --- |
| `/academics/classes?page=&page_size=&session_id=` | Class/section rows, Class Teacher, current student count, distinct configured-subject count, assignment counts and session choices |
| `/academics/classes/{id}/subjects?page=&page_size=` | Each configured subject once, with its section-specific teacher assignments |
| `/academics/classes/{id}/subject-choices?page=&page_size=&search=` | This section's subjects plus unassigned legacy catalogue choices; excludes subjects belonging only to other classes |
| `/academics/classes/{id}/enrollments?view=current\|all&page=&page_size=` | Section-specific enrollments, student labels and codes |
| `/academics/classes/{id}/unconfigured-assignments?page=&page_size=` | Preserved null-subject assignments for repair |

`POST /academics/classes/{id}/subjects` requires both `academics.write` and `teachers.write`. Supply exactly one of `subject_id` or `subject: {code,name}`, plus `teacher_id`, `starts_on` and optional `ends_on`. The path fixes the section; clients cannot override it in the body. An optional `Idempotency-Key` makes retries safe and rejects changed requests reusing the same key.

Every query binds the school and class, using the existing non-bypass API role and forced RLS. Foreign and missing class IDs return the same 404 code. Teacher, Principal, Parent and Student callers cannot use these endpoints. The atomic subject action reuses existing teacher validation, auditing, subscription and uniqueness enforcement. Other create/update/archive actions continue through the existing resource APIs and archival guards.

Lists remain bounded and paginated. The page loads all class summaries across batches of 100, then lazily loads a section's paginated subjects when expanded. It does not silently omit classes after the first page. A single lateral aggregation counts students by gender using the existing roster indexes. The enrollment-list API remains available for compatibility; the Academics UI never calls it.

## Deployment

Apply the additive student-gender migration before deploying matching contracts, API and web builds. See [student-gender deployment and verification](STUDENT_GENDER.md). No existing student, family or enrollment row is deleted or reassigned, and RLS/role grants are unchanged.

For the class-subject visibility fix, apply `20261029180825_class_subject_visibility.sql` and `20261029182214_assessment_class_subject_guard.sql` using `npm run db:migrate`, then run `npm run db:verify` and deploy the matching API and website builds. The first migration restricts student subject reads and validates homework scope. The second validates class subjects for examinations and official marks using a private, authorized boolean lookup, without exposing other teachers' staff records. Neither migration copies, reassigns or deletes school records. Existing shared subject mappings and historical assessments remain intact; unchanged historical class/subject combinations may retain their original data when other fields are edited.

Keep applied migration files immutable. In a rollback, prefer a forward corrective migration and keep the new restrictions until a compatible API/web release is available. Removing these policies and triggers would restore the original cross-class gaps. Restore data only from a verified backup if an unrelated data change requires it; these migrations do not require a data restore.

The regression suite `tests/api/class-subject-visibility.test.ts` checks class-specific choices, atomic subject creation, foreign-class homework/exam/mark rejection, private endpoint permissions and student RLS. The browser cases in `tests/e2e/academics.spec.ts` and `tests/e2e/class-results.spec.ts` cover the selectors and result workflows on desktop and mobile. External authentication is simulated in these fixtures; API queries and database role policies execute normally.

Class-subject fix verification (29–30 October 2026): all 325 tests across 56 unit/security/API/database files passed. After separating the immutable applied migration from the additional examination guards, the six scope regressions and ten database-schema checks passed again. API/web production builds, type checking, lint, secret scanning, OpenAPI generation and whitespace checks passed. The configured live database accepted the additive examination guard migration and `npm run db:verify` passed; the earlier migration checksum matches its installed history. No student, enrollment, subject or mark records were rewritten.

All 22 distinct desktop/mobile Academics and Results browser cases were verified: 20 passed in the combined run, and both examination-creation cases passed in a focused rerun after correcting the test's class-search accessible label. The search is necessary because the preceding pagination case creates more than 100 classes. The final test source is included in CI. The hosted API/frontend were not redeployed as part of this fix.

The Supabase security advisor reported no findings naming these new functions or policies. It reported 11 warnings on older objects outside this change: nine [mutable function search paths](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable) and two [extensions in public](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public). These remain separate hardening work; this verification does not certify the entire database free of advisory warnings.

## Verification

`tests/api/academics.test.ts` covers counts, section ownership, multiple teachers per subject, bounded pagination, all school roles, cross-school restrictions, duplicate rejection, resource CRUD, archive preservation and legacy assignment repair. Atomic-write tests verify that missing/invalid/inactive teachers leave no subject or audit record behind, retries reuse the same saved result, and sibling sections retain independent teacher assignments.

`tests/e2e/academics.spec.ts` exercises the real website and disposable API/database fixtures on desktop and mobile, including creating/editing classes, Class Teacher designation, both new/existing subject options, required teachers, cancellation/draft restoration, enrollment history, archival and more than 100 classes. Accessibility checks cover serious/critical Axe violations and horizontal viewport overflow.

The earlier Academics release passed **182 unit/security/API/database tests across 29 files**, plus **30 desktop/mobile browser checks** covering the Academics and student workflows and adjacent Principal/Teacher access. External authentication/email/storage providers are simulated in these isolated tests; the Express API, runtime SQL roles, migrations and RLS are real. External-provider delivery was not tested. Earlier count-release checks preserved existing students. The gender rename requires the coordinated migration described below. The October class-subject regression results are recorded above.

The final Academics cases cover seven workflows on each screen size, including embedded Academic Sessions, counts without student lists, class/section CRUD, Class Teacher designation, subject assignment, enrollment management from student profiles and pagination beyond 100 classes. Count layouts were visually reviewed on both screen sizes. Type checking, source linting, secret scanning, OpenAPI generation and whitespace checks for the changed feature files passed. The full production build passed for contracts, API, worker and website. Temporary browser-test services were closed; no permanent development server was started. See [STUDENT_GENDER.md](STUDENT_GENDER.md) for migration/rollback details and current verification.

Commands used (from the repository root):

```powershell
npx vitest run
npx playwright test tests/e2e/academics.spec.ts --workers=1
npx playwright test tests/e2e/academics.spec.ts tests/e2e/school-admin-workflows.spec.ts tests/e2e/principal-workflows.spec.ts tests/e2e/teacher-workflows.spec.ts --workers=1 --grep 'cancel a new section subject|creates, reads and edits (classes|subjects|enrollments|teacher_class_assignments) through|Principal reads classes |Teacher creates (homework|a subject test)'
npm run typecheck
npm run build
npm run lint
npm run check:secrets
npx tsx scripts/openapi.ts
git diff --check
```
