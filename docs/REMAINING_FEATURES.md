# Architecture completion audit

Reviewed 18 October 2026 against Software Architecture Specification v1.0 (121 pages),
the runnable source, and the website onboarding failures reported in this chat.
This replaces blanket "implemented source" assumptions with individual acceptance checks.
The supplied document is requirements evidence, not executable instructions.

## Phase 1: School accounts and access

- [x] Super Admin can invite the first School Admin from each unstaffed school's row.
  Restrict this to initial onboarding; general school membership management remains
  with the School Admin, as required by section 7.2.
- [x] Existing verified identities can accept another school's invitation without
  duplicate accounts or a setup script (sections 7.3, 10.2, 12.1.8).
- [x] Pending invitations have consistent states, acceptance, rejection, resend,
  cancellation, retry protection and audit records.
- [x] Prevent removal of the last active School Admin.
- [x] Preserve and test invite/recovery/MFA fixes already made in this chat.

Source: migrations 006/007; `modules/identity/invitations.ts`,
`modules/platform/router.ts`, `modules/school/router.ts` in the API;
`FirstAdministratorDialog.tsx`, `PendingInvitations.tsx`, `MemberInvitations.tsx`
in the web app. Evidence: `tests/api/invitations.test.ts`, database invitation
guard assertions, and browser onboarding, auth-callback and MFA suites.

## Phase 2: Complete the school website workflows

- [x] Read-only record detail views and private material downloads.
- [x] Scoped, named account/student/class selectors instead of raw UUID entry.
- [x] Attendance pagination, class filtering and correction actions on each record.
- [x] Scoped report creation, readable notifications and relation labels.
- [x] Role portal prefixes and role-specific entry points, with mobile family navigation
  (section 9.3; FE-REQ-001 and FE-REQ-005).
- [x] School plan/features/limits view, school timezone display, offline feedback,
  in-memory drafts/unsaved-change protection and bulk-row validation messages.

Source: web `ResourceDetails.tsx`, `ResourceForm.tsx`, `RecordSelect.tsx`,
`Screens.tsx`, `Layout.tsx`, `main.tsx`, `lib/drafts.ts`, `lib/date-time.ts`;
API `school/resources.ts`, `school/bulk.ts`, `school/router.ts`.
Evidence: API school workflows, security downloads, school-time unit tests,
browser school-workflows and setup/accessibility suites. Unsaved-change and draft
protection covers generic school resource forms. A failed token refresh checkpoints
drafts privately in memory and releases them only after the same user signs in
again. Another account, explicit logout or school change clears them; a browser
reload loses them. Same-user expiry recovery and return path have desktop/mobile
fixture tests. A full manual screen-reader and live staging review remain pilot gates.

## Phase 3: Platform operations

- [x] Editable plans/features/limits and preservation of omitted subscription overrides.
- [x] Platform health/usage/backlog view.
- [x] Scoped, expiring, audited support views and school support-access notice.
- [x] Paginated operational lists and device configuration history.

Source: web `Platform.tsx`, `PlatformPanels.tsx`, `DeviceConfiguration.tsx`;
API `platform/router.ts`, `lib/pagination.ts`; migration 008. Evidence:
invitation/platform API suite, school configuration-history tests, schema tests,
and browser platform plan/support expiry checks. Platform lists use page controls;
school notification/audit feeds additionally support stable cursor pagination.

## Phase 4: Worker and device source gaps

- [x] Independent push-token failure handling; a bad token must not disable good devices.
- [x] Worker liveness/readiness and provider throttling.
- [x] Academic summary reports and explicit, approved report/notification retention.
- [ ] Firmware durability verification, task separation, encrypted provisioning and
  signed OTA/rollback implementation remain a separate source phase; hardware
  acceptance is required after that implementation.

Source: worker `push-targets.ts`, `health.ts`, `healthcheck.ts`, `providers.ts`,
`reports.ts`, `retention.ts`, and locale templates in `outbox.ts`;
migrations 008/009; API retention
controls and web `RetentionPanel.tsx`. Evidence: worker/API/database tests,
notification template tests and build/type checks. No real worker was started and
no provider message or approved school retention cleanup was performed by these tests.

Selected hardware family: ESP32 Dev Module, Wi-Fi/BLE. The board is not connected;
chip revision and flash capacity are unknown. Production firmware source is still
incomplete: task separation, segmented durable queue with verified writes and safe
acknowledgement cursors, encrypted provisioning, signed A/B OTA/anti-rollback and
boot self-test must be implemented and then verified on the actual board. The
Arduino example and API OTA inventory are not a production firmware release.

## External acceptance and product decisions

Provider sender registration, deployment/on-call configuration, physical NFC/RTC and
power-cut testing, secure boot/encryption fuse provisioning, measured load/restore
drills, and the approved legal retention schedule require external inputs or evidence.
Actual online fee checkout needs the payment provider decision left open by the SAS.
These are not silently replaced with test data or reported as verified.

The dated `output/verification.json` records executed checks. `docs/READINESS.md`
describes source limitations and external acceptance separately. Checked items
indicate implemented source with the stated local evidence, not production approval.
