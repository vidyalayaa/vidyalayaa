# Student gender and parent limit

All current website labels, form/API fields, CSV templates/exports and database queries use **Gender** and `students.gender`. Values are `MALE`, `FEMALE`, `OTHER`, `NOT_SPECIFIED`; existing values are retained without inference.

New admissions support one or two parents. The database prevents a third active family connection, including direct API/database writes, reactivation and moving a connection to another student. Revoked family history remains visible in exports. Existing students above the limit are preserved; revoke surplus links explicitly before adding new active parents.

## Deploy together

The two new migrations are `20261025101219_student_parent_limit.sql` and `20261025101545_student_gender.sql`. The field is renamed in place, including its validation constraint; no student values are copied, cleared or guessed. Previously applied migration files stay unchanged to preserve their checksums.

Coordinate the schema and API/frontend rollout: the renamed column requires the matching API build. Use a maintenance window when an older API shares the database. Back up through the existing deployment procedure and use the migration-owner connection with verified TLS:

```powershell
npm run db:migrate
npm run db:verify
npm run build
```

Deploy the matching API and website. Never reset or seed a populated database to apply this change. These source changes do not themselves deploy the schema to a hosted project.

Verify without displaying individual student data:

```sql
SELECT gender, count(*) FROM students GROUP BY gender ORDER BY gender;
SELECT count(*) AS invalid FROM students
WHERE gender IS NULL OR gender NOT IN ('MALE','FEMALE','OTHER','NOT_SPECIFIED');
SELECT school_id, student_id, count(*) AS active_parent_count
FROM student_parents WHERE status='ACTIVE'
GROUP BY school_id, student_id HAVING count(*)>2;
```

The last query reports pre-existing families requiring review; it does not delete them. The trigger uses the existing student row to serialize attachment writes, so concurrent writers cannot both fill the last available parent place. Its function runs with invoker privileges and retains tenant RLS. A newly linked parent updates the student's existing modification timestamp.

Prefer a corrective forward migration if a rollout fails. Restoring an older application requires a coordinated compatible schema; do not drop student columns or family records. To withdraw only the parent-limit policy, an authorized migration can drop `student_parent_limit` on `student_parents` and its private trigger function; that removes the cap without altering saved family links.

## Tests

Upgrade tests compare student values, enrollments, family links and RLS before and after the gender rename. Parent-limit tests preserve older over-limit families while blocking new links, reactivation and moves. API tests cover two-parent admissions, third-parent rejection and revocation. Browser checks cover the Gender form label, two-parent controls, template/import/export and existing profile workflows. Tests use isolated fixtures, not production school records.

Verified on 25 October 2026: all **278 tests across 46 files** passed, along with **10 desktop/mobile browser checks** covering admissions, Gender labels, two-parent controls, class counts and CSV workflows. Production builds, TypeScript checks, lint, secret scanning and whitespace checks passed. Hosted database migrations and deployment remain to be performed together as described above.
