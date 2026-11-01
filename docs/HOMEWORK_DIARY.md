# Homework diary

The existing `/r/assignments` navigation now opens a date-wise subject diary for
School Admin, teachers, principal and students. The parent workspace uses the
same diary under its verified child scope; its existing child selector is preserved.
The diary shows homework only. Study materials remain available in Academics,
using the same existing assignment records and attachments.

## Database and rollout

`20261101070628_homework_diary.sql` adds assigned date, instructions, an HTTPS
reference link and a notification revision counter. Existing assigned dates are
backfilled from creation time in each school's timezone. No records are deleted.
Existing class, subject, teacher, student and parent RLS restrictions remain active.
Homework deletion archives the assignment using `retired_at` and writes an audit entry.

Run `npm run db:migrate` and `npm run db:verify` before deploying the worker, API,
then website (`npm run build`, existing Render deployments, `firebase deploy --only hosting`).
Keep the additive migration on application rollback; do not edit applied migrations.

## API and notification behavior

- `GET /api/v1/homework/diary?date=YYYY-MM-DD&class_id=UUID&page=1&kind=HOMEWORK`
  returns subject-labelled rows (50 per page), school-scoped classes, and monthly
  date counts. The diary always requests `kind=HOMEWORK`. The API retains its
  `kind=MATERIAL` option for compatibility; it is not exposed in the Homework UI.
- `/api/v1/parent/children/:childId/homework/diary` additionally enforces the selected
  authorized child. It is read-only, including requests made directly to the API.
- Existing `/resources/assignments` create/update endpoints and private attachment
  upload/download contracts are reused. `DELETE /homework/:id` archives homework.
- Assignment creation/editing queues a versioned HOMEWORK job in the existing
  notification outbox. The worker checks the assignment revision, current enrollment,
  parent authorization and school settings again before delivery. Deleted or
  superseded versions are not sent. Future assigned dates queue for that school's
  midnight. Homework follows the School Admin's Announcement notification switches
  and parent announcement preferences; normal channel/provider limits apply.
- Auth emails are unaffected. Homework push/email/SMS uses the existing worker,
  FCM/Resend/SMS configuration. Inbox/device delivery requires configured providers.

## Submissions

The inspected module had no student submission/status/feedback tables or workflow.
This update preserves assignment instructions, reference material and private
teacher attachments. It does not invent submission statuses or present a nonworking
student-upload/teacher-feedback workflow. These would require a separate submission
storage and review feature if desired.

## Verification

Run `npx vitest run tests/api/homework-diary.test.ts tests/api/student-learning.test.ts tests/api/worker.test.ts tests/api/notifications.test.ts`
and `npx playwright test tests/e2e/homework-diary.spec.ts --workers=1`.
Tests use isolated PostgreSQL and simulated delivery; no real emails or pushes are sent.

Verified on 1 November 2026: eight diary API/database/worker tests passed, along
with 34 existing student-learning and notification/worker regression tests.
Ten desktop/mobile role cases passed across the final role run and the corrected
School Admin selector rerun. These cover diary navigation, subject grouping,
read-only roles and School Admin add/edit/delete. The page was visually reviewed.
Production builds, TypeScript checks, lint and secret scanning passed.

The migration is applied to the configured database. A bounded read-only schema
verification passed and confirmed all three existing homework/material records
remain present with assigned dates. Live email/FCM delivery was not tested.
The API, worker and Firebase website still require deployment for hosted use.
