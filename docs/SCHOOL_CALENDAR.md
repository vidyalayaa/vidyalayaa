# School calendar

All roles use `/calendar` under their existing portal. The legacy `/r/school_holidays` URL redirects here. The calendar has a contribution-style year overview and a dated month view, with navigation, school-local Today, type/class/section filters, keyboard date selection and an event-type legend. Mixed-type dates use multiple colors; every date button has an accessible date, event count and type description.

School Admin can select a date and create, edit or delete events. Forms include title, description, type, inclusive start/end dates and audience. Choose Entire school, all listed sections of one or more classes, or individual sections. A class selection resolves to the existing section records shown at save time; newly created sections are not silently added to a previously targeted event. Multiple selected sections share one event row.

Supported types: Holiday, School event, Exam, Activity, Important announcement, Other, plus existing Weekend opening and Short day attendance-calendar types. A calendar announcement is an event entry; creating one does not send messages or publish a separate announcement automatically.

## Source and compatibility

The existing `school_holidays` table remains the only calendar source. Migration `20261022144925_school_calendar_events.sql` adds `ends_on`, `description`, `target_class_ids`, `version` and a server-maintained duplicate fingerprint. It preserves legacy IDs, dates, kinds, labels, class references and timestamps. Existing single-section rows are initialized with their section UUID; school-wide rows have an empty target array. Null end dates retain the original one-day meaning.

Targets are canonical sorted UUIDs validated against same-school class records and protected against hard deletion of referenced classes. The existing scalar `class_id` remains synchronized for one-section records; multi-section records use the array and have a null scalar. Do not interpret a null scalar alone as school-wide: an empty target array is authoritative. Archived class references remain available for historical management but cannot be added as new targets.

The old resource API remains compatible with its four original kinds and single-section contract. Use the calendar API for multi-day/multi-section event management. The database trigger also validates and canonicalizes legacy writes. The new frontend replaces the generic calendar-record editor for every role.

Duplicate active events are rejected when normalized title, kind, date range and target sections match. Different events on the same date are allowed. Deletion archives the event, preserves its record and audit history, and frees its duplicate fingerprint. Edits and deletes require the displayed version; stale writes return 409. The UI retains its request key across a lost-response retry. Writes retain subscription restrictions and creation/update/deletion audits with before/after metadata.

## Visibility and roles

| Role | View | Manage |
| --- | --- | --- |
| School Admin | All events and non-archived class choices in its school | Create/edit/delete with `calendar.write` |
| Principal | School-wide and all class events in its school | No |
| Teacher | School-wide and currently assigned-class events | No |
| Student | School-wide and events for its current dated ACTIVE enrollment, with an ACTIVE student record | No |
| Parent | School-wide and events for current dated ACTIVE enrollments of ACTIVE children linked through an ACTIVE parent/family connection | No |

Every school role receives `calendar.read`; only School Admin receives `calendar.write`. The existing tenant RLS remains forced, with additional restrictive read and per-operation write policies. Parent/student/teacher class rules are evaluated inside the database, not only in React. Target labels in API responses are additionally restricted to the caller's authorized sections. Missing and unauthorized event IDs return the same 404. Class filters cannot be used to probe another school or an unauthorized section. Roles, memberships, inactive records, dates and revoked links are rechecked on each read.

School-wide events remain visible with a class/section filter. Class-specific events require a selected-section overlap. Existing event types retain their attendance meaning across every date in a multi-day range: a targeted holiday affects only its sections. Informational school events, activities, announcements and other entries do not change attendance rules. Where attendance-calendar records overlap, a section-specific record takes precedence over a school-wide record; within a scope, Holiday, Weekend opening, Exam and Short day have deterministic priority.

Dashboards reuse the same authorized calendar API for the next 30 days. Student/parent views show only applicable events; no dashboard event copy or separate calendar store is created. Selecting an upcoming event opens its calendar date. No additional outbound provider credentials are needed.

## API

All routes use `/api/v1`, existing verified authentication/MFA and `X-School-Id`.

| Method/path | Contract |
| --- | --- |
| `GET /calendar/classes` | Paginated accessible class/section choices, including session labels |
| `GET /calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD` | Inclusive overlapping date range up to 366 days; optional `kind`, comma-separated `class_ids`, `page`, `page_size` (1–100) |
| `GET /calendar/events/{id}` | One applicable event or 404 |
| `POST /calendar/events` | `calendarEventSchema`, returns 201 |
| `PATCH /calendar/events/{id}` | Full event body plus `expected_version` |
| `DELETE /calendar/events/{id}` | `{expected_version}`; archives rather than hard-deleting |

Create/update body:

```json
{
  "title": "Sports days",
  "description": "Bring your sports kit.",
  "kind": "ACTIVITY",
  "start_date": "2027-03-10",
  "end_date": "2027-03-12",
  "audience": "SCHOOL",
  "class_ids": []
}
```

For targeted events use `audience: "CLASSES"` and one or more unique section UUIDs in `class_ids`. Each write accepts `Idempotency-Key` (8–200 safe characters). Event responses contain `id`, body fields, authorized `targets` with class/session labels, and `version`. The frontend follows all calendar/class pages in batches of 100 and deduplicates by ID, so the year view does not truncate at the first page.

## Deploy, verify and recover

Back up the database using the existing procedure. Configure the migration-owner connection and verified TLS, then run from the repository root:

```powershell
npm run db:migrate
npm run db:verify
npm run build
npx vitest run
npx playwright test tests/e2e/school-calendar.spec.ts tests/e2e/family-calendar.spec.ts tests/e2e/principal-workflows.spec.ts --workers=1 --grep "School Admin creates, edits and deletes one|Calendar year/month|Calendar loads all|shows applicable dashboard/calendar|Principal views the school calendar"
```

Apply the migration before deploying matching API and frontend builds, because queries use the new columns and permission codes. Refresh existing browser sessions so `/me` reloads their permissions. Do not reset or seed a populated database. The migration runs transactionally and creates no duplicate holiday/event rows. The existing export, backup and approved-purge processes continue to use the same table and include its new columns.

`db:verify` checks forced RLS, calendar read restrictions, the duplicate index and the private integrity trigger's grants. Read-only verification:

```sql
SELECT count(*) AS total,
       count(*) FILTER(WHERE ends_on<on_date) AS invalid_dates,
       count(*) FILTER(WHERE dedupe_key IS NULL) AS missing_fingerprints
FROM school_holidays;
```

Verify allow/deny behavior using the role tests, including an unassigned section and another school. Calendar deletion should hide the event while retaining a non-null `retired_at` in a migration-owner inspection.

Prefer a forward fix when rolling back. Retain the schema, policies and new attendance resolver: an old resolver would incorrectly interpret multi-section records with null `class_id` as school-wide and ignore multi-day end dates. Do not drop the target/version columns or read policies, modify applied migration files, or overwrite migration ledger checksums. A schema rollback requires an approved backup and separately reviewed conversion of modern events; simply deploying old API code is unsafe.

Tests use real Express handlers, migrations, runtime database roles and RLS with disposable PostgreSQL fixtures. External Auth is simulated; no live invitations or calendar notifications are sent. Coverage includes legacy preservation, multi-day/leap-year placement, duplicate and retry handling, version conflicts, archive/delete behavior, target validation, multi-child/current-enrollment scope, role/tenant boundaries, subscription restrictions, attendance integration, date selection, filters, keyboard access, desktop/mobile layouts and dashboard links.
