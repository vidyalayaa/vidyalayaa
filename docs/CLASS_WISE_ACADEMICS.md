# Class-wise School Admin Academics

School Admin → **Academics** opens `/admin/academics`. Classes are grouped by academic session and grade, with each section beneath its class. Expand any section to manage its subjects, teachers, Class Teacher and enrollments without leaving the page. Other roles retain their existing workspaces.

## Source of truth

- A `classes` row already identifies the academic session, grade and section. Its `class_teacher_id` is the single Class Teacher designation.
- `subjects` is a school-wide catalogue. A section's configured subjects are the distinct subjects referenced by its non-archived `teacher_class_assignments`, joined to non-archived catalogue subjects. No new class-subject table or copied subject records are created.
- The same subject can have multiple teachers and be used by multiple sections. It appears once per section with its teacher-assignment rows beneath it. Dates and inactive teachers remain visible for management.
- Enrollments come from `enrollments.class_id`, with the matching school and academic-session relationships preserved. The current student count and current student list use the same active enrollment/student and school-local date rules. **All enrollment records** includes future and ended records for editing and historical review.
- Preserved legacy assignments without a subject appear in **Assignments needing a subject** within their own section. Repair updates the existing row; archive preserves its history.

## Management

Use **Add class & section** or the class's **Add section** action. Existing forms enforce the required Class Teacher and unique session/grade/section relationship. Edit the class/section or designate its Class Teacher inside the expanded section.

**Add subject & teacher** is a single form inside the selected section. Select an existing subject or enter a new subject's code/name, choose its required teacher and save once. The backend saves the subject and dated teaching assignment in one transaction. An invalid teacher rolls back the new subject; cancelling saves neither record. No subject or teacher is automatically assigned to sibling sections. Each section has its own subject assignments, enrolled students and Class Teacher.

Editing a subject's code/name affects that shared catalogue record across sections, as stated in the form. Archive individual teacher assignments to remove their teaching relationship from this section, without deleting the catalogue subject or another section's assignment. Existing database uniqueness checks reject duplicate subject codes and duplicate teacher/class/subject assignments.

**Enroll student** uses existing student records and locks the form to the selected class and academic session. Edit an enrollment's dates, roll number or status in place. End an enrollment by changing its status to ENDED; use **All enrollment records** to review it. Active enrollments still prevent class archival. Archival never deletes the student, enrollment, subject or assignment history.

The existing resource URLs, school-wide catalogue/session management and CSV tools remain available. The new School Admin navigation points to the grouped workspace; Principal and Teacher navigation are unchanged.

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

Lists remain bounded and paginated. The page loads all class summaries across batches of 100, then lazily loads a section's paginated subjects and enrollments when expanded. It does not silently omit classes after the first page. Queries reuse the existing roster and teacher/class/subject indexes.

## Deployment

This change introduces no database migration or production-data rewrite. Read-only inspection confirmed the configured database already has the preceding teaching migration, including the assessment metadata and Class Teacher permission helpers. No configured data or settings were changed during this work. Deploy matching contracts, API and web builds through the existing process.

## Verification

`tests/api/academics.test.ts` covers counts, section ownership, multiple teachers per subject, bounded pagination, all school roles, cross-school restrictions, duplicate rejection, resource CRUD, archive preservation and legacy assignment repair. Atomic-write tests verify that missing/invalid/inactive teachers leave no subject or audit record behind, retries reuse the same saved result, and sibling sections retain independent teacher assignments.

`tests/e2e/academics.spec.ts` exercises the real website and disposable API/database fixtures on desktop and mobile, including creating/editing classes, Class Teacher designation, both new/existing subject options, required teachers, cancellation/draft restoration, enrollment history, archival and more than 100 classes. Accessibility checks cover serious/critical Axe violations and horizontal viewport overflow.

Executed: the full unit/security/API/database suite passed **171 tests across 27 files**. The adjacent School Admin class/subject/enrollment/teacher-assignment CRUD, Principal read-only class access, and Teacher homework/subject-test browser regressions passed on desktop and mobile (**14 checks**). External authentication/email/storage providers are simulated in these isolated tests; the Express API, runtime SQL roles, migrations and RLS are real. Live production writes and external-provider delivery were not tested.

The final Academics desktop/mobile run passed **12 checks** (six workflows on each screen size), including the single-save subject form and navigation back from Academic Sessions. Together with the adjacent role regressions this is **26 distinct browser checks**. Both screen sizes were visually reviewed. Type checking, source linting, the repository secret scan, OpenAPI generation and diff whitespace checks passed. The full production build passed for contracts, API, worker and website. Temporary browser-test services were closed; no permanent development server was started.

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
