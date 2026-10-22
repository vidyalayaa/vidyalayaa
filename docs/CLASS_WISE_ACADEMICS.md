# Class-wise School Admin Academics

School Admin → **Academics** opens `/admin/academics`. Classes are grouped by academic session and grade, with each section beneath its class. Expand a section to manage subjects, subject teachers and its Class Teacher, and see student counts by recorded sex. Individual student records and enrollment management belong to Students. Other roles retain their existing workspaces.

## Source of truth

- A `classes` row already identifies the academic session, grade and section. Its `class_teacher_id` is the single Class Teacher designation.
- `subjects` is a school-wide catalogue. A section's configured subjects are the distinct subjects referenced by its non-archived `teacher_class_assignments`, joined to non-archived catalogue subjects. No new class-subject table or copied subject records are created.
- The same subject can have multiple teachers and be used by multiple sections. It appears once per section with its teacher-assignment rows beneath it. Dates and inactive teachers remain visible for management.
- Enrollment totals come from `enrollments.class_id`, with the matching school and academic-session relationships preserved. Only active students with dated active enrollments on today's school-local date contribute. Each section returns `student_count`, `male_count`, `female_count`, `other_count` and `unspecified_count`. The four categories sum to the total. Existing students default to NOT_SPECIFIED; no sex is inferred from a name. Academics does not fetch or display individual student rosters.
- Preserved legacy assignments without a subject appear in **Assignments needing a subject** within their own section. Repair updates the existing row; archive preserves its history.

## Management

Use **Add class & section** or the class's **Add section** action. Existing forms enforce the required Class Teacher and unique session/grade/section relationship. Edit the class/section or designate its Class Teacher inside the expanded section.

**Add subject & teacher** is a single form inside the selected section. Select an existing subject or enter a new subject's code/name, choose its required teacher and save once. The backend saves the subject and dated teaching assignment in one transaction. An invalid teacher rolls back the new subject; cancelling saves neither record. No subject or teacher is automatically assigned to sibling sections. Each section has its own subject assignments, enrolled students and Class Teacher.

Editing a subject's code/name affects that shared catalogue record across sections, as stated in the form. Archive individual teacher assignments to remove their teaching relationship from this section, without deleting the catalogue subject or another section's assignment. Existing database uniqueness checks reject duplicate subject codes and duplicate teacher/class/subject assignments.

Use **Students → student profile → Class enrollments** to add/edit class, session, dates, roll number and status, including future or ended records. End an enrollment by changing its status to ENDED. Active enrollments still prevent class archival. Archival never deletes student, enrollment, subject or assignment history.

**Academic sessions** expands management inside this workspace; add, edit and archive actions use the existing forms and resource APIs. School Admin's legacy session/class/subject/teacher-assignment URLs redirect here; legacy enrollment URLs redirect to Students. Principal and Teacher navigation are unchanged. The separate generic academic resource tables are no longer entry points for School Admin.

## API and permissions

All paths use the existing `/api/v1` base, verified authentication and selected school context. The new aggregation endpoints require the School Admin role and academic/student/teacher read permissions; they do not grant additional write permissions.

| GET path | Result |
| --- | --- |
| `/academics/classes?page=&page_size=&session_id=` | Class/section rows, Class Teacher, current student count, distinct configured-subject count, assignment counts and session choices |
| `/academics/classes/{id}/subjects?page=&page_size=` | Each configured subject once, with its section-specific teacher assignments |
| `/academics/classes/{id}/enrollments?view=current\|all&page=&page_size=` | Section-specific enrollments, student labels and codes |
| `/academics/classes/{id}/unconfigured-assignments?page=&page_size=` | Preserved null-subject assignments for repair |

`POST /academics/classes/{id}/subjects` requires both `academics.write` and `teachers.write`. Supply exactly one of `subject_id` or `subject: {code,name}`, plus `teacher_id`, `starts_on` and optional `ends_on`. The path fixes the section; clients cannot override it in the body. An optional `Idempotency-Key` makes retries safe and rejects changed requests reusing the same key.

Every query binds the school and class, using the existing non-bypass API role and forced RLS. Foreign and missing class IDs return the same 404 code. Teacher, Principal, Parent and Student callers cannot use these endpoints. The atomic subject action reuses existing teacher validation, auditing, subscription and uniqueness enforcement. Other create/update/archive actions continue through the existing resource APIs and archival guards.

Lists remain bounded and paginated. The page loads all class summaries across batches of 100, then lazily loads a section's paginated subjects when expanded. It does not silently omit classes after the first page. A single lateral aggregation counts students by sex using the existing roster indexes. The enrollment-list API remains available for compatibility; the Academics UI never calls it.

## Deployment

Apply the additive student-sex migration before deploying matching contracts, API and web builds. See [student-sex deployment and verification](STUDENT_SEX.md). No existing student, family or enrollment row is deleted or reassigned, and RLS/role grants are unchanged.

## Verification

`tests/api/academics.test.ts` covers counts, section ownership, multiple teachers per subject, bounded pagination, all school roles, cross-school restrictions, duplicate rejection, resource CRUD, archive preservation and legacy assignment repair. Atomic-write tests verify that missing/invalid/inactive teachers leave no subject or audit record behind, retries reuse the same saved result, and sibling sections retain independent teacher assignments.

`tests/e2e/academics.spec.ts` exercises the real website and disposable API/database fixtures on desktop and mobile, including creating/editing classes, Class Teacher designation, both new/existing subject options, required teachers, cancellation/draft restoration, enrollment history, archival and more than 100 classes. Accessibility checks cover serious/critical Axe violations and horizontal viewport overflow.

The latest verification passed **182 unit/security/API/database tests across 29 files**, plus **30 desktop/mobile browser checks** covering the Academics and student workflows and adjacent Principal/Teacher access. External authentication/email/storage providers are simulated in these isolated tests; the Express API, runtime SQL roles, migrations and RLS are real. External-provider delivery was not tested. The additive recorded-sex migration was applied and its schema/security checks passed on the configured database; existing students were preserved.

The final Academics cases cover seven workflows on each screen size, including embedded Academic Sessions, counts without student lists, class/section CRUD, Class Teacher designation, subject assignment, enrollment management from student profiles and pagination beyond 100 classes. Count layouts were visually reviewed on both screen sizes. Type checking, source linting, secret scanning, OpenAPI generation and whitespace checks for the changed feature files passed. The full production build passed for contracts, API, worker and website. Temporary browser-test services were closed; no permanent development server was started. See [STUDENT_SEX.md](STUDENT_SEX.md) for migration/rollback details and current verification.

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
