# Student Academics and Results

Student Academics now displays the student's current class, section, academic session and dates, roll number, designated Class Teacher, subjects and subject teachers together. `/student/r/classes`, `/student/r/subjects`, `/student/r/academic_sessions` and `/student/academics` all open this combined view. Subjects use the current section's existing, non-retired and date-valid teacher/subject assignments. Ended or future enrollments are not presented as current. These are information cards, without administrative tabs or editing actions.

Student Results (`/student/r/marks` and `/student/r/exams`) shows readable examination/subject labels, scores and maxima, percentages, class/section/session, remarks, subject charts and examination charts. Examination and subject filters, pagination and a refresh button are available. Summaries use all matching recorded marks, not only the visible page. Missing marks are not treated as zero; actual zero scores are included. There is no default date filter that could hide older examinations. Published historical marks retain their subject labels after an enrollment or teaching assignment ends.

## Why saved marks might not appear

Saving marks does not publish an examination. Students and parents can see only non-retired examinations whose status is `PUBLISHED`. `OPEN`, `DRAFT` and `LOCKED` exams are hidden. The Results page explains this condition rather than suggesting that students add school records.

School Admin workflow: open **Results → Manage examinations**, select the correct class's exam, finish/check its marks and publish it using the existing status control. Return to the student account and choose **Refresh results**. Publication is an explicit school decision; this update does not publish or change any live examination or mark automatically. If an exam is already published, confirm that the correct student's record is linked to the authenticated account and that the mark belongs to that student and exam.

## Security and deployment

`GET /student/academics` and `GET /student/results` run through the existing student-only profile router, the relevant academic/marks permission, ordinary `app_api` transactions and restrictive RLS. Identity comes from the authenticated account. Arbitrary student/user/class IDs are not accepted. Unknown exam/subject filters return no records and reveal no other student's filter metadata. Student writes receive 405 responses; database policies independently prevent mark and exam writes. Every join is bounded to the active school. Other roles retain their existing workflows and policies.

Deploy contracts, API and website together. Before serving the new version, run the existing migration process with the protected migration-owner connection:

```powershell
npm run db:migrate
npm run db:verify
npm run build
```

Migration `20261030162825_student_learning_scope.sql` adds restrictive student mark/exam policies and extends the existing subject-read policy only for labels referenced by the authenticated student's own published historical marks. It creates no tables or fields and copies, modifies and deletes no school records. Review pending migrations first and follow the existing backup/deployment guide. Application rollback can retain these restrictive policies; do not remove access protections as a quick fix for an application error. A schema rollback requires restoring the prior `student_class_subjects` policy from `20261029180825_class_subject_visibility.sql` and removing the named `student_learning_*` policies after reverting the application, in a reviewed transaction; no data rollback is necessary for this migration.

Verify policies after migration:

```sql
SELECT tablename, policyname, permissive, cmd
FROM pg_policies
WHERE schemaname='public'
  AND (policyname LIKE 'student_learning_%' OR policyname='student_class_subjects')
ORDER BY tablename, policyname;
```

## Checks

Verified on 30 October 2026: 58 API/database checks passed across student learning, student profiles, class results, class-subject visibility, teacher assignments, parent workspace and schema security. Eight desktop/mobile browser cases passed, including the complete empty-results → publish → own-results workflow, charts, historical marks, route aliases, responsive layouts and existing profile restrictions. API and website production builds, full workspace type checking, lint, formatting and secret scanning passed. The browser checks use disposable records and simulated external authentication, not live student accounts.

The new policy migration was also applied to the configured database after checking existing migration checksums and confirming it was the only pending migration. The database security verification passed in the same transaction. No live examination was published and no student marks were changed. The hosted API/website were not redeployed by this work.

```powershell
npm run build -w @vidyalayaa/contracts
npx vitest run tests/api/student-learning.test.ts tests/api/student-profile.test.ts tests/api/class-results.test.ts
npx playwright test tests/e2e/student-learning.spec.ts tests/e2e/student-profile.spec.ts --workers=1
npm run typecheck
npm run build -w @vidyalayaa/api
npm run build -w @vidyalayaa/web
```

Tests use disposable school records, actual API handlers/database policies and simulated external authentication. They cover own-account scoping, publication, zero scores, past enrollments, class-specific subjects, filters and pagination, identity tampering, cross-school access, role restrictions, SQL write denial, legacy URLs, read-only controls and desktop/mobile layouts. No live student marks are written by these tests.
