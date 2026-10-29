# Student CSV import and export

Open **School Admin → Students**. **Import CSV** now imports the same student, enrollment and family information as **Add student & family**. **Export CSV** downloads the school's matching student records with enrollment and parent details. Both features require the School Admin role; other roles retain their existing scoped views.

## Import a complete admission

1. Choose **Import CSV → Download CSV template**. This downloads a blank UTF-8 template with all supported fields, including gender, enrollment and two parent groups.
2. Fill one row per student. Required fields are `student_code`, `first_name`, `class_grade`, `class_section`, `starts_on`, and at least one parent/guardian.
3. Upload the CSV (up to 500 KB and 500 students), then choose **Validate file**. Every row is checked against the current school's records. No admission records or admission audits are retained by validation.
4. Correct all reported rows, validate again, then choose **Import validated records**. If any row fails at save time, the entire file rolls back. Retrying an unchanged submission uses the same retry key. Existing students are not overwritten or silently merged.
5. Invite the imported student and parent accounts afterward through **Members & invitations**. The import creates profiles and family links, not accounts, passwords, memberships or emails. Invitation acceptance still performs the existing verified account linking.

The shared CSV dialog shows two stages: **Validate file** and **Import records**. Its lime progress bar pulses while the server processes a request, shows one completed stage after successful validation, and completes only when the server confirms the imported count. The endpoints save the file atomically and do not stream row-level progress, so the dialog does not invent a percentage or a processed-row count. Keep it open while processing; editing, duplicate submissions and dialog dismissal are blocked until the request finishes. If a save response is lost, the dialog reports that the import is unconfirmed and preserves the existing safe retry key. Changing the CSV clears validation and progress. This also applies to teacher, parent, family-link and subject-teacher assignment imports.

### Student and enrollment fields

| Columns | Values |
| --- | --- |
| `student_code`, `first_name` | Required; codes remain text, including leading zeros |
| `last_name`, `email`, `date_of_birth` | Optional profile details; use `YYYY-MM-DD` for dates |
| `gender` | `MALE`, `FEMALE`, `OTHER`, `NOT_SPECIFIED`; blank defaults to `NOT_SPECIFIED` |
| `status` | `ACTIVE`, `TRANSFERRED`, `GRADUATED`, `WITHDRAWN`; blank defaults to `ACTIVE` |
| `class_grade`, `class_section` | Required; match an existing, non-archived class/section in this school |
| `academic_session` | Exact session name; blank selects this school's current session. Ambiguous/nonexistent matches fail |
| `roll_number` | Optional text |
| `starts_on`, `ends_on` | Start required, end optional; `YYYY-MM-DD`; end cannot precede start |

Classes and academic sessions must be configured before import. The enrollment's session ID comes from the resolved class, never from an arbitrary supplied UUID.

### Parents and family links

Repeat the following fields using `parent_1_` through `parent_2_`. Leave an entire unused parent group blank.

| Suffix | Values |
| --- | --- |
| `mode` | `NEW` (default) or `EXISTING` |
| `full_name` | Required for `NEW` |
| `email`, `phone` | Optional for `NEW`; `EXISTING` requires a unique active same-school parent email and blank name/phone |
| `relationship` | `MOTHER`, `FATHER`, `GUARDIAN`, `OTHER`; blank defaults to `GUARDIAN` |
| `is_primary_contact` | `true` or `false`; defaults to true for parent 1 and false for others; at most one primary contact |
| `can_receive_alerts` | `true` or `false`; defaults to true |

For siblings, create the parent as `NEW` on the first student's row, then use `EXISTING` with that parent's email on later rows. You can also link parents already in this school. Import never overwrites an existing parent's name, phone or account link. Reusing a `NEW` email already present in this school produces an error instead of creating a duplicate. Parents without email cannot be safely matched by name or phone; select an existing parent using the admission form instead.

The template contains all columns, but optional columns may be omitted. Empty optional cells are ignored. Boolean flags accept true/false, not yes/no. Quoted commas, embedded quotes and multiline text are supported. Unknown/duplicate headers and unequal cell counts fail instead of silently losing information. Excel users should format student codes, roll numbers and phone columns as Text before entering data; a CSV cannot recover leading zeros already removed by a spreadsheet.

## Export student records

**Export CSV** exports all matching records across all result pages, respecting the Students page's name/code/email search and academic-session filter. Clear filters to download all students in this school, including inactive and unassigned students.

The export includes student profile fields, the current enrollment (or latest enrollment when none is current), and all linked parent contacts, relationships, primary-contact and alert flags. `enrollment_status`, `parent_N_status` and `parent_N_link_status` preserve read-only state, including revoked links. If older records have more than two active parents, the export adds columns so those contacts are not silently omitted.

This is a record export, not an automatic update file. It includes existing students, existing parent names and read-only statuses. Use the blank import template for new admissions. When adapting exported rows for new students, remove read-only columns, choose NEW/EXISTING parent mode deliberately, leave existing-parent name/phone blank, and supply the new student code and valid enrollment. Existing students are never overwritten by importing an export.

The CSV uses UTF-8 with a BOM for spreadsheet compatibility. Quotes/newlines are escaped and spreadsheet formula prefixes receive an apostrophe for safety; this also applies to values such as international phone numbers beginning with `+`. Exports contain private student/family information, not passwords, session credentials or service keys. Attendance, examination and fee histories remain in their existing reports/exports.

## API and deployment

- `POST /api/v1/student-directory/imports`: `studentImportRequestSchema`, `{ rows: [...], validate_only: true }` for preview. Commit sets `validate_only: false` and requires `Idempotency-Key`. Each row follows the shared `studentImportRowSchema`. Requires `users.manage`, `students.write`, `parents.write` and the directory's existing read permissions, a writable subscription and quota availability.
- `GET /api/v1/student-directory/export.csv`: authenticated School Admin and directory read permissions; selected `X-School-Id` required. Optional `search` and `academic_session_id`. Streams batches under one repeatable-read snapshot, with formula protection, attachment disposition and `Cache-Control: no-store`.

Both paths retain the existing non-bypass runtime role, tenant transaction context and database RLS. Deploy the new parent-limit and gender migrations before the matching API and frontend. Hosting topology stays unchanged. Deploy matching contracts, API and frontend builds. The older generic `/imports/students` record-only contract remains available for compatibility; the Students page uses the new complete-admission endpoint.

Tests use disposable PostgreSQL-compatible fixtures and simulated authentication. No real accounts, invitation emails or FCM messages are sent.

```powershell
npm test -- tests/unit/csv.test.ts tests/api/student-import-export.test.ts tests/api/student-directory.test.ts tests/api/audit-regressions.test.ts
npx playwright test tests/e2e/student-csv.spec.ts --workers=1
npm run typecheck
npm run build
npm run contracts
npm run lint
npm run check:secrets
```

## Verification — 25 October 2026

The subsequent two-parent and Gender correction passed the full **278-test regression suite** and **10 desktop/mobile checks**, including data-preserving migration tests. See [Gender and parent-limit deployment](STUDENT_GENDER.md). These migrations must be applied before using the matching API and website builds.

- 35 focused API/database and unit tests passed across the CSV, admission and existing audit regression suites.
- 10 desktop/mobile browser checks passed: template download, complete family import, validation rollback, required revalidation after edits, lost-response retry safety, filtered export and existing import workflow compatibility. The import dialog also passed its serious/critical accessibility check.
- Full production build, TypeScript checks, source lint, secret scan and whitespace checks passed. OpenAPI was regenerated from shared contracts.
- Tests used isolated fixtures; no production database records, real invitations or FCM messages were changed. Render API and worker remain separate. Deployment to external hosting was not performed.
