# Student sex and Academics counts

`db/migrations/20261022141625_student_sex_counts.sql` adds `students.sex` as non-null text with a database CHECK constraint. Accepted values are `MALE`, `FEMALE`, `OTHER`, `NOT_SPECIFIED`. The default is `NOT_SPECIFIED`, including existing records. No sex is inferred from a name, family member, account or email.

School Admin can record sex in the combined admission form or Edit student. The student card and full profile show it. Existing API callers and CSV imports remain compatible when they omit sex. Student write permissions, tenant RLS, ownership rules and audit handling remain authoritative.

Academics shows total, male, female, other and unspecified enrollment counts for each section. Counts include only active students with ACTIVE enrollments whose dates include the school-local current date. Sex categories reconcile to the total and remain scoped to the same school and class. Student names and individual enrollment rows are not fetched by the Academics page.

## Deploy

Back up the database with the existing backup procedure, configure the migration-owner connection and verified TLS certificate, then run from the repository root:

```powershell
npm run db:migrate
npm run db:verify
npm run build
```

The runner applies pending migrations transactionally and verifies existing migration checksums. Do not reset/seed a populated database or overwrite migration ledger hashes. If a historical checksum differs, compare the exact applied source before proceeding; line-ending differences also affect this runner's byte hashes. Deploy the schema before the new API because the count query reads `students.sex`.

Verify without exposing individual records:

```sql
SELECT sex, count(*) FROM students GROUP BY sex ORDER BY sex;
SELECT count(*) AS invalid FROM students
WHERE sex IS NULL OR sex NOT IN ('MALE','FEMALE','OTHER','NOT_SPECIFIED');
```

The second query must return zero. `npm run db:verify` checks the column, constraint and existing RLS/grant invariants. With School Admin authentication, compare `/api/v1/academics/classes` totals to its four sex categories; check another school is inaccessible. No external credentials are required for isolated unit/database/browser tests.

## Rollback

To roll back application code, retain the additive column and constraint: older clients tolerate them, and recorded sex is preserved. Do not drop the column in a populated database. A destructive schema rollback requires an approved backup/export of recorded values and a separate reviewed migration; do not modify an applied migration or delete its ledger entry.

## Tests

```powershell
npx vitest run
npx playwright test tests/e2e/academics.spec.ts tests/e2e/student-directory.spec.ts --workers=1
npm run typecheck
npm run lint
npm run check:secrets
```

Tests use real migrations, PostgreSQL runtime roles, RLS and Express against disposable databases; external Auth/email services are simulated. They cover preserving legacy rows, invalid API/database values, admission/edit persistence, count reconciliation, class/school isolation, unauthorized writes, embedded session/enrollment CRUD, legacy URL redirects, absent roster requests and desktop/mobile accessibility.

Verification on 2026-10-22: all **182 tests across 29 files** passed, along with type checking, source linting, secret scanning and the complete contracts/API/worker/web production build. OpenAPI was regenerated from shared contracts. The additive migration was applied to the configured database, and its schema/security verification passed with existing students retained as NOT_SPECIFIED. No Auth accounts, family links or enrollments were changed by this migration.

The final browser rerun passed **30 desktop/mobile checks**: seven Academics workflows, four student directory/admission workflows, three Principal profile/access workflows and one Teacher roster workflow on each screen size. This includes sex saving/editing, count-only Academics without roster requests, embedded session/enrollment CRUD, legacy URL redirects, more than 100 classes, guardian reuse/rollback and accessibility. Desktop/mobile count layouts were visually reviewed. Initial test-only failures from hot reload, short waits, nested-dialog timing and overlapping fixture grades were resolved before this clean rerun. Temporary test services shut down after completion; no permanent development server was started.
