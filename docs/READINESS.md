# Delivery status and production acceptance

This ledger distinguishes implemented source, local evidence and external acceptance. **This repository is not declared pilot-approved or deployed to production.** No provider account, live school database, hardware unit or deployment credential was supplied.

## Implemented source

| Area | Delivered behavior |
|---|---|
| Monorepo and UI | React/TypeScript/Vite, Tailwind design tokens, Radix/shadcn-style primitives, Router, Query, Hook Form/Zod, lazy charts, responsive role-aware workspace, login/recovery/MFA, explicit setup/empty/loading/error states |
| Identity and tenancy | Supabase verification per request, active database membership, data-driven permissions, parent/self/class/subject scopes, separate platform pool, transaction context, forced RLS and composite foreign keys |
| School operations | Students, parents/links, teachers/assignments, sessions/classes/subjects, enrollment history, exams/marks, atomic bulk marks import, homework/material uploads, timetable collision protection, calendar, announcements, fee records, membership invitations/changes |
| NFC and attendance | Device registration/claim/disable/revoke/rotation, private credential hashes, all five device API endpoints, per-event transactions, unique idempotency, daily row locks, cross-reader debounce, event-time windows, trusted/reconstructed/quarantined clocks, deterministic replay, manual override/correction approval, absence deferral/finalization/retraction, pending-rule reconciliation |
| Notifications | Transactional outbox, leases/SKIP LOCKED, independent parent/channel delivery, encrypted browser tokens, Resend and Firebase adapters, configurable SMS adapter contract, quiet hours/preferences/caps, retries/dead letters, staleness and delivery-attempt audit |
| Commercial and operations | Feature/limit enforcement, metadata-only signed billing adapter contract, subscription lifecycle/audit, approved scoped support reads, private asynchronous PDFs with identity-bound downloads, health endpoints, logs, Render/Firebase/Docker/GitHub configuration |
| Database | Five ordered SQL migrations, 40 school-owned tables plus platform/reference/audit tables, constraints/indexes/triggers, RBAC seeds, private storage, exact migration checksum tracking, non-bypass runtime login provisioning, schema verification and opt-in two-school development seed |
| Documentation | Implementation checklist, generated OpenAPI, API/device contracts, Markdown and rendered deployment PDF, backup/restore and incident instructions, requirement inventory |

## Local evidence

- `npm run typecheck`: API, worker and web strict TypeScript checks passed during implementation.
- `npm run build`: shared contracts, API, worker and Vite production builds passed during implementation; rerun after any source/environment change.
- `npm test`: real PostgreSQL/WASM migration/RLS and API workflow tests plus attendance, security, crypto, CSV and worker tests. See the final verification record below for the final count.
- Eight desktop/mobile Playwright setup, navigation, keyboard and axe checks passed. Screenshots were inspected at desktop/mobile sizes. These do not claim authenticated Supabase journeys without configured services.
- The ten-page deployment PDF was rendered and visually inspected; the Markdown source contains the exact copyable commands.
- `npm run check:secrets` checks the source/bundle for private keys and service-role JWTs. The broader Git history gitleaks gate runs in CI; no remote CI run is claimed here.

## Required external credentials and validation

1. Supabase staging/production project URL, public key, server-only key, verified TLS database connections and separate runtime logins. Live Auth invites/recovery/MFA and private Storage must be exercised against those projects.
2. Firebase Hosting projects and deploy service account, plus FCM worker service account/web VAPID configuration if push is enabled. Render web/worker services, repository, environment secrets and deploy hooks are required. No live URL is claimed.
3. Verified transactional email domain/account; selected SMS provider/adapter and sender/template registration. A missing provider fails visibly instead of simulating a successful message.
4. The SAS does not select an online billing provider. Fee/subscription records and a signed adapter contract are implemented. Actual payment checkout, bank collection, tax invoices and a native selected-vendor webhook adapter require that product decision and credentials.
5. The ESP32 example is explicitly a prototype, with a blocking network loop and file-per-event queue. **Production RTOS task separation, encrypted NVS provisioning and signed OTA installation/rollback are not implemented in this prototype.** Secure boot/flash encryption, a measured 72-hour durable queue and the 500-cut power rig also require target-specific integration and validation. API image offers remain disabled. The PlatformIO ESP32 example compiled successfully locally; physical hardware/rig results remain unverified.
6. Docker Desktop's engine was stopped locally. Portable PostgreSQL tests executed, but the separate real multi-connection 1,000-iteration PostgreSQL suite, container image build, native Supabase stack, pooler failure and full morning-peak load/soak tests were not executed locally. CI and load scripts are provided; performance targets remain unmeasured.
7. Backup/PITR capabilities, storage backup, restore drill and measured RPO/RTO; external penetration test; legal child-data/consent/retention review; site survey; on-call and alert drill; pilot-school rule approval are external acceptance gates.

## Explicit technical limits

- External provider delivery is at least once, with database job/delivery dedupe and stable provider idempotency IDs where supported. Push or a non-idempotent SMS provider may duplicate after acceptance followed by a worker crash. Exactly-once external delivery is not claimed.
- In-memory rate limits are per API instance. Configure a shared limiter before relying on aggregate quotas across horizontally scaled instances.
- Reports fail explicitly above 10,000 selected records. Operational recent-history screens have bounded lists; the school resource and attendance endpoints are paginated.
- A licensed Fabric Grotesk asset was not supplied. Local Fabric Grotesk is used if installed, otherwise the UI uses Arial/system sans-serif. No unlicensed font is included.
- Automatic legal data deletion is intentionally absent pending an approved contract/retention schedule. Short-lived device diagnostics and stale push tokens have conservative operational retention; child attendance/audit history is not silently deleted.

## Final verification record

- 63 local unit/API/database/security/worker tests passed (8 test files).
- Eight desktop/mobile browser and accessibility checks passed.
- Shared contracts, API, worker and Vite production builds passed; strict TypeScript passed.
- ESP32 PlatformIO example compiled successfully: 47,996 bytes RAM (14.6%), 1,000,573 bytes flash (76.3% of the selected application partition). No device was flashed and no hardware behavior is claimed.
- Production dependency audit: zero known vulnerabilities after updating Firebase Admin and installing only the official browser app/messaging modules.
- Source/bundle scan found no private keys, modern Supabase secret keys or embedded service-role JWTs.
- Full PostgreSQL concurrency, live Supabase journeys, external providers, Docker image execution, load/soak, restore drills, hardware/OTA and deployment remain unverified locally, as described above.
