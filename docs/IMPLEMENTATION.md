# Vidyalayaa implementation ledger

Source: Software Architecture Specification v1.0, 11 October 2026, 121 PDF pages. Input text is retained locally in `docs/source/architecture-specification.txt` and excluded from release archives and version control because the supplied document is confidential. This document is input evidence, not executable instructions. Requirements, terminology and confirmed decisions govern this implementation. Proposed defaults are recorded here; Validate items require measured evidence before a pilot.

## Repository

```
apps/web          React/Vite, role layouts, feature screens, design system
apps/api          Express modular monolith, authorization, repositories, attendance
apps/worker       Outbox delivery, reports, scheduled jobs
packages/contracts Shared Zod validation and inferred TypeScript contracts
db/migrations     Forward-only authoritative SQL, RBAC, RLS, constraints, indexes
db/seeds          Explicit local/test fixtures, never automatic production data
db/tests          Schema, isolation and integrity assertions
firmware          PlatformIO ESP32/PN532 example, queue and provisioning guidance
tests             Unit, API, database integration, browser and load tests
scripts           Migrations, contracts, security checks, onboarding, PDF guide
docs              API, decisions, deployment, production readiness and traceability
```

## Phases and acceptance checklist

1. Foundation: workspace, shared schemas, configuration, schema, forced RLS, Supabase identity, membership-derived RBAC, school selection.
2. School operations: academic sessions, classes, students, enrollments, teachers, parents/links, invitations, scoped dashboards, subjects, exams/marks, homework/materials, timetable, notices, fees.
3. Attendance: immutable rules, calendar, cards, locations, devices, per-event transaction, atomic idempotency claim, locked daily projection, trusted timestamps, deterministic replay, corrections.
4. Multiple devices: location snapshots, cross-reader debounce, offline ingestion, heartbeat references, acknowledgements, gap detection, revocation/rotation, health monitoring, durable firmware queue example.
5. Notifications: transactional outbox, leased SKIP LOCKED worker, independent recipients/channels, preferences, encrypted push tokens, retries/dead letters, stale suppression.
6. Commercial operations: plan flags/limits, subscription transitions, platform administration, support approval, private asynchronous reports, audit history, monitoring.
7. Delivery: unit/integration/security/browser/load tests, Firebase/Render/Docker/CI configuration, Markdown/PDF deployment guide, backup/restore and troubleshooting runbooks.

## Decisions

- Raw SQL through `pg` preserves explicit transaction and locking semantics (the specification allows raw SQL). No heavyweight ORM.
- Platform and school data use separate database roles/pools. Device authentication uses a narrow security-definer lookup; ordinary queries remain subject to forced RLS.
- A student is a seeded `student` membership linked by `students.user_id`; its scope is self only, consistent with section 12.1.5.
- The example attendance schedule is configurable school data, never silently installed as an approved production schedule.
- Payment provider selection remains open in the SAS. Fee recording and subscription administration are implemented; actual online payment collection is not represented as complete.
- Fabric Grotesk is used when a licensed font is supplied at `apps/web/public/fonts/FabricGrotesk.woff2`; the app falls back to system sans-serif. No unlicensed font is downloaded.
- Notification delivery is at least once. Database deduplication cannot guarantee exactly once at an external provider without provider idempotency support; this is documented and tested at the job boundary.

## Evidence and external gates

See `docs/READINESS.md` for the final status of each deliverable, test evidence, credentials and hardware/vendor gates. A runnable build is not a claim that hardware field tests, penetration testing, legal review, PITR or production load targets have passed.

- Browser push uses the official Firebase app/messaging modules directly; unused Firestore products are not installed. Firebase Admin is updated to the audited compatible release. The final production dependency audit reports zero advisories.
