# Class-wise School Admin results

Open **Results** (`/admin/r/marks`), choose a **Class and section**, and then an **Examination** from that section. Each class row is the existing section/session record; sections with the same grade remain separate. Choices include academic-session labels and load every page of classes and examinations.

After choosing an examination, its student marks appear. **Add record** asks for a student enrolled in that section. For a subject test, the subject is fixed to the test's subject. For an official examination, choose a subject configured for the section through its existing teacher-subject assignments. The dialog shows the selected class, examination and maximum score. Changing class clears the examination and removes the previous results/form context.

**Import CSV** uses the examination already selected on Results. The examination is fixed in the import dialog. Student and subject codes are resolved against the examination's class, and the existing bulk endpoint validates the complete upload before saving. Only OPEN examinations offer entry, editing and CSV upload; DRAFT, LOCKED and PUBLISHED examinations remain available for viewing. Manage examinations preserves the existing examination workflow; creating a subject test now filters its subject choices by class and clears the subject when the class changes.

No tables, examinations, marks or enrollments are copied or migrated. Existing marks retain their IDs and scores. School Admin marks queries include both `class_id` and `exam_id`; the backend intersects these filters through the exam's class. Subject choices reuse the same non-archived teacher-class-subject relationships used by Academics. Individual and bulk writes retain enrollment, exact subject-test subject, maximum-score, exam status, authentication, subscription, role and school checks. Teacher official-exam/Class Teacher restrictions and family/Principal read permissions are unchanged.

For older official marks whose subject mapping has since been removed, the existing selected subject remains on the saved record; this change does not delete or rewrite historical marks. Newly offered subject choices come from the section's configured subjects.

## Verification

From the repository root:

```powershell
npm run typecheck
npx vitest run tests/api/class-results.test.ts tests/api/teacher-assignments.test.ts tests/api/workflows.test.ts
npx playwright test tests/e2e/class-results.spec.ts tests/e2e/school-admin-workflows.spec.ts --workers=1 --grep "Class-first results|Official results show|Creating a class subject test|reads and edits marks|imports marks into|reads and edits exams"
npm run build
```

Tests use disposable databases and real API handlers/RLS with simulated external authentication. They cover section-specific choices, independent tests/subjects, saving and editing results, context resets, official marks, CSV import/publication, locked exams, invalid cross-class writes, bulk rollback and role/school boundaries. No live student marks are changed during verification. No database migration or additional provider credentials are required; deploy the matching API and website builds together.

Completed checks: 42 targeted API/workflow/permission tests and 12 desktop/mobile browser checks passed. The full monorepo production build, type checking, source lint, secret scan and changed-feature formatting checks also passed.
