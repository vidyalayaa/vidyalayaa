# Delivery status and production acceptance

Updated 18 October 2026. This ledger distinguishes implemented source, local evidence and external acceptance. **This repository is not declared pilot-approved or deployed to production.** A configured Supabase project and Super Admin identity exist; all nine migrations have been applied and schema verification passed. Local web/API services are configured. No connected ESP32 unit, production cloud deployment, external provider acceptance or measured recovery/load result is claimed.

## Implemented source

| Area | Delivered behavior |
|---|---|
| Monorepo and UI | React/TypeScript/Vite, Tailwind design tokens, Radix/shadcn-style primitives, Router, Query, Hook Form/Zod, lazy charts, responsive role-aware workspace, login/recovery/MFA, explicit setup/empty/loading/error states |
| Identity and tenancy | Supabase verification per request, active database membership, data-driven permissions, parent/self/class/subject scopes, separate platform pool, transaction context, forced RLS and composite foreign keys |
| School operations | Students, parents/links, teachers/assignments, sessions/classes/subjects, enrollment history, exams/marks, atomic bulk marks import, homework/material uploads, timetable collision protection, calendar, announcements, fee records, membership invitations/changes |
| NFC and attendance | Device registration/claim/disable/revoke/rotation, private credential hashes, all five device API endpoints, per-event transactions, unique idempotency, daily row locks, cross-reader debounce, event-time windows, trusted/reconstructed/quarantined clocks, deterministic replay, manual override/correction approval, absence deferral/finalization/retraction, pending-rule reconciliation |
| Notifications | Transactional outbox, leases/SKIP LOCKED, independent parent/channel delivery, encrypted browser tokens, Resend and Firebase adapters, configurable SMS adapter contract, quiet hours/preferences/caps, retries/dead letters, staleness and delivery-attempt audit |
| Commercial and operations | Feature/limit enforcement, metadata-only signed billing adapter contract, subscription lifecycle/audit, approved scoped support reads, private asynchronous PDFs with identity-bound downloads, health endpoints, logs, Render/Firebase/Docker/GitHub configuration |
| Database | Nine ordered SQL migrations, forced RLS and composite tenant keys, RBAC seeds, private storage, immutable migration checksum ledger, separate non-bypass runtime logins, invitation acceptance/last-admin guards, worker delivery targets/provider quotas/configuration snapshots, opt-in retention and development seed |
| Documentation | Implementation checklist, generated OpenAPI, API/device contracts, Markdown and rendered deployment PDF, backup/restore and incident instructions, requirement inventory |

## Local evidence

- `npm run typecheck`: API, worker and web strict TypeScript checks passed during implementation.
- `npm run build`: shared contracts, API, worker and Vite production builds passed during implementation; rerun after any source/environment change.
- `npm test`: real PostgreSQL/WASM migration/RLS and API workflow tests plus attendance, security, crypto, CSV and worker tests. See the final verification record below for the final count.
- Desktop/mobile Playwright suites cover setup, keyboard/axe, verified invite/recovery callbacks, MFA QR and duplicate factors, first-admin/Principal onboarding, plans/support expiry, private homework, attendance and in-memory drafts. Authenticated tests use isolated API/Auth fixtures and ignore local service credentials. See the verification record for executed counts; these are not external provider acceptance tests.
- The deployment guide is generated from the Markdown source, which contains exact copyable commands. PDF page count and visual checks are recorded with the final artifacts.
- `npm run check:secrets` checks the source/bundle for private keys and service-role JWTs. The broader Git history gitleaks gate runs in CI; no remote CI run is claimed here.

## Required external credentials and validation

Google sign-in was added on 19 October 2026 alongside email/password, with PKCE callbacks, assigned-role routing and API enforcement of enrolled MFA. The configured project's Google provider was confirmed disabled, and the owner has not yet created a Google OAuth client. Follow `docs/GOOGLE_SIGN_IN.md` to supply credentials and callback URLs; real Google provider acceptance remains pending. Isolated tests cover all six roles and do not substitute for this external setup. The deployment guide is now version 1.2.

1. The configured development Supabase project is migrated and verified. Independent staging/production projects, verified TLS runtime roles and controlled secret injection still need release validation. Exercise live Auth invites/recovery/MFA, multi-school role journeys and private Storage against the intended staging project before promotion. Development setup is not staging acceptance.
2. Firebase Hosting projects and deploy service account, plus FCM worker service account/web VAPID configuration if push is enabled. Render web/worker services, repository, environment secrets and deploy hooks are required. No live URL is claimed.
3. Verified transactional email domain/account; selected SMS provider/adapter and sender/template registration. A missing provider fails visibly instead of simulating a successful message.
4. The SAS does not select an online billing provider. Fee/subscription records and a signed adapter contract are implemented. Actual payment checkout, bank collection, tax invoices and a native selected-vendor webhook adapter require that product decision and credentials.
5. The chosen family is ESP32 Dev Module with Wi-Fi/BLE, but it is not connected and chip revision/flash size are unverified. The example has a blocking network loop and file-per-event queue. **Production RTOS task separation, verified durable segment/cursor handling, encrypted NVS provisioning and signed OTA installation/rollback are not implemented in this prototype.** These are source gaps as well as hardware acceptance gates. Secure boot/flash encryption, a measured 72-hour queue and the 500-cut power rig require target-specific integration and validation. API image offers remain disabled. The unchanged prototype compiled in the earlier delivery; no board has been flashed.
6. Docker Desktop's engine was stopped locally. Portable PostgreSQL tests executed, but the separate real multi-connection 1,000-iteration PostgreSQL suite, container image build, native Supabase stack, pooler failure and full morning-peak load/soak tests were not executed locally. CI and load scripts are provided; performance targets remain unmeasured.
7. Backup/PITR capabilities, storage backup, restore drill and measured RPO/RTO; external penetration test; legal child-data/consent/retention review; site survey; on-call and alert drill; pilot-school rule approval are external acceptance gates.

## Explicit technical limits

- External provider delivery is at least once, with database job/delivery dedupe and stable provider idempotency IDs where supported. Push or a non-idempotent SMS provider may duplicate after acceptance followed by a worker crash. Exactly-once external delivery is not claimed.
- HTTP abuse limits remain per API instance; configure a shared limiter before relying on aggregate HTTP quotas across API replicas. Worker provider/channel token buckets are shared durably in PostgreSQL.
- Reports fail explicitly above 10,000 selected records. Operational school/platform lists have pagination; school audit and notification feeds also support cursor mode. Approved support views intentionally limit each authorized read to 100 rows.
- A licensed Fabric Grotesk asset was not supplied. Local Fabric Grotesk is used if installed, otherwise the UI uses Arial/system sans-serif. No unlicensed font is included.
- CI currently enforces strict type checks, tests, builds and security scans; a separate lint rule set is still a source/configuration gap against OPS-REQ-001. Manual screen-reader/accessibility, tablet acceptance and production error-monitoring integration are not established by the setup axe tests.
- Retention is opt-in per school with an approval reference. It expires completed generated report files and prunes old COMPLETED notification delivery records only. It preserves underlying academic/attendance/fee records, child profiles, audit logs and PENDING/DEAD jobs. There is no automatic legal child-data deletion policy. Review policy and contractual plan cap before enabling it; no real school policy was enabled by the implementation tests.

## Final verification record

- Executed counts, commands and remaining unexecuted suites are recorded in `output/verification.json`; use that dated record rather than assuming every SAS acceptance test ran.
- The 18 October baseline passed 88 unit/API/database/security/worker checks across ten test files and 54 desktop/mobile browser scenarios. On 19 October the Google login follow-up passed 39 targeted unit/API checks and 62 desktop/mobile login, MFA, recovery and school workflow scenarios. These are separate runs, not a combined suite count. The updated version 1.2 deployment PDF has 12 pages and was rendered and visually reviewed.
- Shared contracts, API, worker and Vite production builds passed; strict TypeScript passed.
- ESP32 PlatformIO example compiled successfully: 47,996 bytes RAM (14.6%), 1,000,573 bytes flash (76.3% of the selected application partition). No device was flashed and no hardware behavior is claimed.
- Production dependency audit: zero known vulnerabilities after updating Firebase Admin and installing only the official browser app/messaging modules.
- Source/bundle scan found no private keys, modern Supabase secret keys or embedded service-role JWTs.
- Full PostgreSQL concurrency, staging Supabase journeys, external providers, Docker image execution, load/soak, restore drills, hardware/OTA and cloud deployment remain unverified locally, as described above.

## Additions in this audit pass

First School Admin onboarding is available from Super Admin > Schools. The School Admin then invites Principals and other members from Members & invitations. Existing verified accounts accept in Settings. Membership remains INVITED until explicit acceptance; retries are leased, failures visible, cancellation/decline audited, and the final active administrator is protected by PostgreSQL. All roles use the same email/password or configured Google sign-in, followed by server-authorized role portals.

School pages now provide readable record details/private materials, scoped named selectors, attendance class/date filters and row corrections, named report controls, school plan details, school-timezone inputs, memory-only resource drafts, unsaved-change warnings, offline notices and bulk row errors. Platform pages provide editable plans/limits, subscription controls, private worker/backlog health, expiring audited support and device configuration history. Worker processing tracks each push target separately, shares provider quotas, emits safe English/Hindi templates and produces academic summaries. Detailed source/test mappings are in `REMAINING_FEATURES.md` and `TRACEABILITY.csv`.

Session-expiry recovery now checkpoints unfinished resource drafts in memory before a forced refresh. A same-user sign-in restores them and the return path; another identity, explicit logout or school change clears them. Unit ownership tests and desktop/mobile expiry fixtures cover this behavior. The checkpoint is not persisted and is never displayed before the server authorizes the returning account.
