# Weekly school timetable

The existing Timetable link (`/{role}/r/timetable_entries`) opens a weekly grid. Select a class and section, including its academic-session label. The default week is Monday–Saturday; saved school days can include any combination of Monday–Sunday. Periods and breaks appear in time order, and the grid scrolls horizontally on small screens without widening the page.

## School Admin workflow

1. Open **School timings**. Choose school days, the start time, default lecture duration and lecture count (1–16).
2. Add named breaks with start/end times. Select **Generate lecture times** to fit lectures around breaks. Adjust individual lecture labels and times as needed, then save.
3. Select the class and section. Choose an empty lecture cell or **Add lecture**, select a configured period and a class subject, then choose one of that subject's assigned teachers. A room is optional.
4. Edit a lecture to change its period, day, subject, teacher or room. **Delete** asks for a reason and archives the existing record, preserving its ID and audit history.

New lecture entry is enabled after school timings are saved. An unsaved template is clearly labelled and creates no synthetic lecture records. Timing changes do not silently move existing lectures: old times/days remain visible as original-timing rows or extra existing-day columns. Edit those lectures to reschedule them into the new template. Unchanged legacy lectures can retain their original time when only their room changes. Archived lectures free their occupied slot.

Subjects and teachers come from existing, non-archived `teacher_class_assignments` for the exact class/section, with an active teacher staff record and currently applicable assignment dates. A Class Teacher designation alone does not create a subject assignment. Configure subjects and their teachers in Academics before scheduling them. Removed/inactive assignments are highlighted for School Admin; rescheduling requires a valid current assignment.

## Roles and validation

| Role         | View                                                                      | Manage                                  |
| ------------ | ------------------------------------------------------------------------- | --------------------------------------- |
| School Admin | All non-archived classes/sections in the school                           | Timings and lecture create/edit/archive |
| Principal    | All non-archived classes/sections in the school                           | No                                      |
| Teacher      | Current assigned classes, including Class Teacher designations            | No                                      |
| Student      | Own active, currently dated enrollment                                    | No                                      |
| Parent       | Active children with an active family link and currently dated enrollment | No                                      |

Existing `timetable.read` and `timetable.write` permissions, verified authentication/MFA and the timetable plan feature remain in force. Subscription read-only restrictions continue to block writes. Timetable writes and timing changes require School Admin in both the API and database. Current ownership/assignment checks are enforced by restrictive RLS even when selecting timetable rows directly through the runtime database role. A revoked family link or ended enrollment removes access on the next request.

Lecture and break times must form a valid non-overlapping same-day template, with numbered periods matching the lecture count. New or rescheduled lectures must match a configured school day and exact lecture interval. Existing database exclusion constraints prevent overlapping bookings for either a class or a teacher, including concurrent writes outside Express. Different classes may use the same slot with different assigned teachers. No room-booking constraint is introduced.

## Storage and API

There is no second timetable store. Lectures remain in `timetable_entries`; `schools.settings.timetable` stores the validated timing template and its version. Other school settings are preserved. Migration `20261023070540_school_timetable.sql` adds functions, triggers, restrictive policies and a lookup index without rewriting any lecture or school settings.

All endpoints use `/api/v1`, verified authentication and `X-School-Id`:

| Endpoint                                        | Use                                                                                      |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `GET /timetable/settings`                       | `{configured, version, settings}`; unsaved defaults have version 0                       |
| `PUT /timetable/settings`                       | `{expected_version, settings}`; School Admin and writable timetable entitlement required |
| `GET /timetable/classes`                        | Paginated authorized class/section choices                                               |
| `GET /timetable/classes/{id}/entries`           | Paginated lectures with subject/teacher labels                                           |
| `GET /timetable/classes/{id}/assignments`       | School Admin-only active subject/teacher choices                                         |
| `POST /resources/timetable_entries`             | Existing lecture creation contract and idempotency support                               |
| `PATCH /resources/timetable_entries/{id}`       | Existing lecture update contract                                                         |
| `POST /resources/timetable_entries/{id}/retire` | Existing `{reason}` archive action; returns 204                                          |

Timing saves use an optimistic version and support `Idempotency-Key`. Stale saves return `TIMETABLE_VERSION_CONFLICT`. Invalid assignments and periods return `TIMETABLE_ASSIGNMENT_INVALID` / `TIMETABLE_PERIOD_INVALID`; existing bookings return `TIMETABLE_CONFLICT` or the database constraint-conflict response. There are no new browser grants, public functions or security-definer functions. Trusted migration/restore owners retain their existing maintenance paths.

For compatibility, the generic lecture API accepts custom valid times before a school has saved its first timing template. Exact template matching becomes mandatory for new or rescheduled lectures after that template is saved. The weekly UI always requires saved timings before creating lectures.

## Deployment, verification and recovery

Apply the migration before starting the matching API/frontend build. Do not seed or reset an existing school database.

```powershell
npm run db:migrate
npm run db:verify
npm run build
npx vitest run
npx playwright test tests/e2e/timetable.spec.ts tests/e2e/timetable-roles.spec.ts --workers=1
```

The migration preserves existing IDs, lecture times, rooms, archive timestamps, audit history and all school settings. Database verification checks the new guards and restrictive read policy, while the existing forced tenant RLS and teacher/class exclusion constraints remain enabled. Backups and school exports continue to capture the same lecture table and school settings.

Prefer a forward fix. If reverting the UI, retain the database policies and guards: the generic resource API also benefits from these protections. Existing entries outside a saved timing template remain readable; new schedules must use configured periods. Do not edit applied migrations or drop timing settings to bypass validation. Restore from a verified backup only through the existing approved recovery process.

Automated tests use disposable PostgreSQL fixtures and real Express handlers/RLS, with external authentication simulated. They cover lecture creation/edit/archive, school days and individual periods, breaks, teacher/class conflicts, valid subject-teacher assignments, direct SQL denial/ownership, version/idempotency behavior, read-only subscriptions, legacy preservation and desktop/mobile role views. Live validation must not create test lectures in a real school.

### Verification record — 23 October 2026

- Full regression suite: 211 tests passed across 36 files, including API, database, authorization and unit checks.
- Timetable browser suite: 12 checks passed across desktop and mobile, covering School Admin management and Teacher, Student and Principal read-only views. The six School Admin checks were repeated after the mobile sticky time-column adjustment.
- Migration applied to the connected database and database verification passed. Comparisons confirmed all existing lecture rows and school settings were preserved; no test lectures were created in live schools.
- Supabase security advisors returned the same pre-existing findings before and after the migration, with no new timetable findings.
- Production builds passed for shared contracts, API, background worker and frontend, including TypeScript checks. Lint, secret scanning, timetable file formatting and Git whitespace checks passed. Vite reported the existing non-blocking ResourceScreen import/chunk warning.

Browser authentication is simulated in isolated fixtures; these results do not claim a real-user sign-in or production deployment test.
