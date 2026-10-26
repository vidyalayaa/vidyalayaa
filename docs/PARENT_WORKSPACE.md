# Parent workspace

## Attendance and result insights

Parent attendance now shows every calendar date in the chosen range, up to today,
with date/status filters, quick month/year ranges and paginated daily records.
Totals cover the entire chosen range, independently of pagination or the status
filter. School-day classification follows dated enrollment, versioned attendance
rules (including a record's pinned rule), targeted holidays and weekend overrides.
When no attendance rule applies, saved timetable days are used, falling back to
the application's Monday–Saturday default with a visible notice. Historical class
transfers do not discard the child's earlier section holidays.

Recorded absences remain `ABSENT` and support the existing correction-request
workflow. A date without an official row is `NOT_RECORDED`, not an invented
absence. Holidays, weekly offs and days outside enrollment are distinguished.
Parents never create or update official attendance through this read view.

The attendance percentage is `(PRESENT + LATE + HALF_DAY) / finalized school days
* 100`. Finalized days include recorded absences and excused days; pending and
unrecorded days are excluded and shown separately. An empty denominator displays
no percentage. Recorded attendance takes precedence over calendar classification.

Published result graphs compare subject percentages and show examinations in date
order, using all filtered records rather than one table page. Totals are weighted
by maximum marks, so 90/100 and 5/10 yield 95/110 (86.4%), not the average of 90%
and 50%. Missing marks are never treated as zero. Parents can filter by date,
examination and subject, and read the accessible marks table below the graphs.
When an examination has no scheduled date, its record date is explicitly labeled.

New read contract: `/parent/children/:childId/results/insights`. The existing
`/attendance` projection now adds `summary`, `range` and `uses_default_schedule`.
Both keep live family ownership and the selected-child transaction scope.
Apply `20261026114359_parent_attendance_calendar.sql` with the existing migration
runner before deploying the updated API.

Parents use the existing `/parent` portal and existing school records. There is no
new authentication system, calendar, timetable, fee ledger or notification queue.

## Access and selection

An active parent membership must have an active `parents` profile linked through
an active `student_parents` relationship to an active student in the same school.
The child selector is available on every parent content page, including one-child
accounts. Selection survives navigation and is stored per account and school in
session storage. `?child_id=<uuid>` can deep-link an authorized child; an unknown
or unauthorized ID shows no records. An unlinked account receives an empty state.

Every section is scoped to the selected child. Calendar, homework, announcements,
academic subjects and timetable use current dated enrollment; school-wide dates
and announcements remain visible. Published historical marks, attendance, fee
charges and payments remain tied to the child. Staff announcements and unpublished
marks are hidden. Personal notifications are restricted to the recipient; account-wide
messages may appear for every selected child. Notifications about another child
or another class are excluded. Only the parent's own correction requests and
report requests are listed.

Parents may request attendance corrections and private child reports through the
existing endpoints. They cannot edit students, parents, enrollments, subjects,
teacher assignments, attendance, marks, examinations, fees, timetable or events.
Device notification opt-in/out and personal privacy/security settings remain available.
Existing authorized staff retain their workflows. Parents see issued receipts and
payment status; they cannot record payments or reverse them.

## API

- `GET /api/v1/parent/children`: authorized children with current class, section,
  roll number, session and Class Teacher. No authentication IDs are returned.
- `GET /api/v1/parent/children/:childId/profile`: student details and the caller's
  own parent contact, excluding other parent profiles.
- `GET /api/v1/parent/children/:childId/{attendance,academics,homework,results,fees,payments,reports,announcements,notifications,corrections}`:
  parent-facing, paginated projections (`page`, `page_size`).
- `GET /api/v1/parent/children/:childId/calendar/{classes,events}`:
  existing calendar contracts and range/filter parameters.
- `GET /api/v1/parent/children/:childId/timetable/settings`,
  `/timetable/classes`, `/timetable/classes/:id/entries`: existing read contracts.
- Existing `/corrections`, `/reports`, material downloads and receipt endpoints
  retain their live ownership checks. Report generation requires the separate
  background worker already used by the application.

The checked child ID is set transaction-locally, never from an unchecked database
claim or browser role. Restrictive parent RLS applies to legacy resource endpoints
as well. Private boolean lookup functions avoid policy recursion, bind the live
membership and school, and cannot be executed by browser database roles. Parent
RLS does not grant direct browser access to tables or storage.

## Deployment and verification

1. Back up the database using the existing backup procedure.
2. Build and test: `npm run build`, `npm test`, `npm run typecheck`, `npm run lint`.
3. Apply `npm run db:migrate`, then `npm run db:verify` using the existing migration
   connection. Parent migrations are `20261026105147_parent_workspace.sql` and
   `20261026114359_parent_attendance_calendar.sql`, applied in order by the runner.
4. Deploy the API and frontend together. Existing workers remain separate and
   continue processing corrections/report jobs under their existing role.
5. Verify a one-child parent, a multi-child parent, an unlinked parent, and a
   revoked relationship. Try unrelated child/record IDs through legacy APIs and
   the parent APIs. Verify staff pages still work.

Focused automated checks:

```sh
npx vitest run tests/api/parent-workspace.test.ts tests/unit/parent-insights.test.ts
npx playwright test tests/e2e/parent-workspace.spec.ts tests/e2e/family-calendar.spec.ts tests/e2e/parent-insights.spec.ts --workers=1
```

Browser tests use isolated Express services and a disposable PostgreSQL-compatible
database. Auth and outbound providers are simulated. They do not send real email,
FCM notifications, or modify a hosted database.

## Rollback

The migration does not delete or rewrite school records. Prefer rolling back the
application while retaining the restrictive ownership policies. Removing those
policies restores broader database access and requires a reviewed security change;
do not remove them as an automatic deployment rollback. The previous application
does not send a child context, so parent RLS defaults to all currently authorized
children while maintaining family isolation.
