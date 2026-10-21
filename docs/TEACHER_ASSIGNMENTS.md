# Teacher assignments and assessment permissions

Owner-requested update, 21 October 2026. Class Teacher is a designation on a class, not a new account role. This update extends the original Teacher workflows and preserves the other school and platform roles.

## School Admin setup

1. Add active staff records with staff role **Teacher**. Invite their accounts using the existing record-bound invitation workflow.
2. Create sessions and subjects. In **Classes & Sections**, select exactly one active **Class Teacher** when creating or editing every class/section. A class record contains both its grade and section.
3. Open **Teacher assignments**. Add one row for each teacher, class/section and subject combination, with start/end dates. Repeat for multiple classes or subjects.
4. Change the Class Teacher through **Classes & Sections** when needed. This designation is independent of subject assignments; a Class Teacher needs an explicit subject assignment to set homework or create subject tests.
5. Create official examinations under **Exams & results**, with assessment kind **Official**. A **Subject Test** requires a subject.

Teaching access requires the current academic session and an active teacher profile and membership. Expired/retired subject assignments stop granting subject access. Replacing the Class Teacher revokes manual attendance and official marks access on subsequent requests, including idempotent retries. Existing unassigned classes remain intact for migration safety; School Admin must assign a Class Teacher before editing them. New or edited active classes cannot have an empty Class Teacher. Inactive teacher profiles grant no access.

## Teacher website

- **Students & Parents**: choose an assigned class/section; view its students and authorized active parent contacts and student profiles.
- **Attendance**: subject teachers can view their assigned classes. Only the designated Class Teacher can manually mark attendance or request corrections for their class and enrolled students. School Admin and Principal retain their existing management/review permissions. NFC evidence still requires approved corrections; raw records cannot be deleted.
- **Homework**: choose an assigned class and explicitly assigned subject.
- **Subject tests**: create/edit tests and enter or upload marks for an exact assigned class/subject.
- **Official exam results**: only the designated Class Teacher can enter/upload official marks for that class, across subjects. School Admin retains official-exam management and audited mark entry.
- Only OPEN assessments accept marks. Locked/published results have read-only views. Teachers cannot manage Academic Administration, memberships or school settings.

CSV columns remain `student_code,subject_code,score,remarks`, with at most 500 rows. Invalid/unauthorized uploads save no rows.

## Database and API

Migration: `db/migrations/20261021154148_teacher_subject_authorization.sql`.

- Existing exams and marks retain IDs and values. All existing examinations default to **OFFICIAL**; historical UNIT exams are not guessed to be subject tests.
- Subject tests have an explicit subject. Assessment kind/class/subject cannot change after creation; create another assessment instead.
- Existing null-subject assignments are preserved using a NOT VALID constraint. They never grant wildcard subject access. New/updated assignments require a subject; legacy rows can still be retired. School Admin should review and replace legacy null-subject assignments with explicit subjects.
- Existing forced tenant RLS and non-bypass runtime roles remain. Additional restrictive Teacher policies protect the teaching/academic, family and attendance records. Triggers protect Class Teacher selection, assessment identity, mark validation, attendance enrollment and NFC evidence.
- Private `app` authorization helpers use fixed search paths and explicit tenant/identity checks. Narrow boolean owner lookups avoid recursive RLS without returning private rows. No browser table grants or anonymous/authenticated function grants are added.
- API validation repeats the contextual checks. Teacher academic exports apply the same subject-test/Class Teacher distinction. Existing school access revisions invalidate old reports after designation changes.

| Method/path | Contract |
| --- | --- |
| GET /teaching/classes | classrooms.read; teacher's classes, sections, subjects and is_class_teacher |
| GET /lookups/class-teachers?class_id= | academics.write; eligible active teacher profiles |
| GET /resources/students?class_id= | scoped class students |
| GET /resources/parents?class_id= | authorized class parent contacts |
| GET /resources/subjects?class_id= | assigned subjects; assessment_kind=OFFICIAL allows the designated Class Teacher's subject catalogue |
| GET /resources/exams?class_id=&assessment_kind= | eligible subject tests or designated-class official examinations |
| GET /resources/marks?exam_id= | scoped examination marks |
| POST/PATCH /resources/exams | School Admin management; Teacher subject tests only |
| POST/PATCH /resources/marks; POST /marks/bulk | exact assigned subject test or designated-class official results; School Admin retains access |

Teacher `classrooms.read` replaces `academics.read`. It permits scoped teaching lookups, not administration. `assessments.write` permits subject-test management for Teachers and assessment management for School Admin; examination-kind checks also apply.

## Deployment and verification

The migration was scaffolded with the Supabase CLI and placed in the repository's existing migration system. No configured/cloud database was changed during verification. Do not apply it through a second migration ledger.

Read-only inspection of the configured database found all 23 preceding repository migrations with matching checksums, plus a historical `202610190010_firebase_auth.sql` entry absent from this checkout. The new teaching migration is pending; its assessment columns are absent. The existing class already has a Class Teacher. Reconcile the historical migration with the deployment owner and preserve that ledger entry; do not delete it or reset the database. The code and migration must be deployed together.

Back up the intended staging database, review preceding migrations, configure the migration-owner connection securely, then run from the repository root with supported Node 24:

```powershell
npm run db:migrate
npm run db:verify
npm run build
```

Deploy matching API, worker and frontend builds after migrating. Restart the API/worker and test a School Admin, ordinary subject teacher and Class Teacher with staging accounts.

Useful migration-owner read-only checks:

```sql
SELECT assessment_kind,count(*) FROM exams GROUP BY assessment_kind;
SELECT school_id,id,teacher_id,class_id FROM teacher_class_assignments
WHERE subject_id IS NULL AND retired_at IS NULL;
SELECT school_id,id,class_teacher_id FROM classes WHERE class_teacher_id IS NOT NULL;
SELECT has_table_privilege('authenticated','marks','INSERT') AS browser_mark_writes;
```

There is no destructive automatic down migration: removing metadata/policies would lose categorization or reopen authorization gaps. Stop an affected service, preserve the backup, and use a reviewed forward repair; test any restore in a separate environment first. The migration deletes no records or marks.

See [verification results](TEACHER_VERIFICATION_2026-10-21.md) for executed tests and external limits. Real Auth/Storage, cloud advisors, deployment and native Safari still require staging acceptance.
