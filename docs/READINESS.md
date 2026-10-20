# Website delivery and release acceptance

Updated 20 October 2026. This records delivered source and executed local checks. The website is not declared deployed or approved for a live school. The original 239-row audit remains historical evidence; use AUDIT_IMPLEMENTATION.md and AUDIT_WORK_PACKAGES.csv for the implementation response to its 28 work packages.

## Current scope

The five primary roles are Super Admin, School Admin, Principal, Parent and Student. Documented teacher workflows are retained. Supabase Auth remains the identity authority; Firebase supplies Hosting and FCM. Google/password sign-in and enrolled MFA share the same server-enforced authorization. Manual subscription billing is implemented at the owner's direction. All firmware development and physical-reader acceptance are deferred by the owner.

## Delivered website behavior

| Area | Implemented behavior |
|---|---|
| Identity and access | Password/Google PKCE, MFA enrollment and challenge, invitation/recovery callbacks, role portals, school-approved privileged security policy, verified server identity, current memberships, same-school/child/self/teaching scope and forced database RLS |
| Super Admin | School and first-administrator onboarding, plans and manual subscription controls, device inventory/lifecycle, metadata audit with safe before/after details, approved expiring support, support requests, notices, campus groups, usage, closure and operational health |
| School Admin | Membership invitations, master-record preview/import and retirement, academic records, staff assignments, attendance/review/reconciliation, communications, private materials/reports, fees, security policy, support, usage, private full-school exports and closure approval |
| Principal | Permission-bound school dashboard, academic/attendance analytics, permitted academic operations, published results, reports and attendance correction workflows; School Admin authority is enforced separately |
| Families | Authorized-child selection and scoped Parent records; self-only Student records, published results, attendance, homework/materials, timetable, announcements, fees and permitted profile/privacy preferences |
| Reports and exports | Permission provenance rechecked after generation, identity-bound private downloads, PDF/streaming CSV, formula neutralization, snapshot exports, checksums/manifests and explicit contractual export windows |
| Notifications | Audience/publication version enforcement, transactional outbox, independent channel/recipient targets, push ownership refresh/revocation, lock-screen privacy, reasoned retry, shared provider quotas, bounded timeouts and visible failures |
| Database and operations | 22 forward migrations, separate non-bypass runtime roles, composite tenant keys, immutable audit, shared durable HTTP throttles, optional filtered monitoring, health/release gates, encrypted backup/restore tooling and CI/deployment configuration |

No production feature uses fixture records as an application fallback. Browser/API tests deliberately generate isolated records; they never represent a real delivery, invitation or payment.

## Executed local evidence

- The final isolated unit/API/database/worker/security suite passed 125 checks across 22 files.
- The native runner passed 85 checks across 11 files. API and ownership tests use disposable PostgreSQL 17; the ten direct schema tests still use PGlite. All 22 migrations initialize and verify successfully. The nine-to-22 upgrade preserves existing identities and relationships.
- Separate native tests passed five-reader/5,000-event concurrency, duplicate-request safety, retry after a committed response is lost, scoped indexed queries over 30,000 attendance rows, and a 1,000-student private PDF. A 10,001-row streaming CSV passed isolation and spreadsheet-formula checks.
- Encrypted native restore preserved schema/security and 30,000 generated attendance rows. Authentication tampering and incorrect-key rejection passed. The measured local fixture drill is not cloud RPO/RTO evidence.
- Browser checks cover desktop/mobile role, login, MFA QR/duplicate factor, invitation/recovery, school/Principal onboarding, subscriptions, expiring support, private materials, import/export, security/privacy, attendance and draft/session workflows. The exact final run is recorded in output/verification.json.
- Strict TypeScript, production builds, source lint and source/browser-bundle secret scans passed. The production dependency audit reports zero known vulnerabilities; this does not claim a clean development dependency tree or completed remote image scan.
- The deployment guide is version 1.3, 14 pages, rendered and visually reviewed. Deployment commands and environment examples are provided in docs/DEPLOYMENT.md.

## Database and running-service state

Migrations 010-022 were applied only to disposable test databases during this work. The configured development project was previously reported at migrations 001-009; its current remote state was not re-inspected or changed here. Review, back up, migrate and verify staging before using the new source against that project. No persistent website/API/worker was launched as a delivery step, no production records were changed and no cloud deployment or Git push is claimed.

## Explicit remaining work

1. T16 still has a source follow-up: specialized response projections do not all have separately generated runtime Zod contracts; deeper route/business-service/repository extraction remains. Existing shared operation/resource schemas and OpenAPI do not constitute complete response-contract coverage.
2. Configure Google OAuth, Auth redirect/SMTP settings, runtime database credentials/TLS, private Storage, Firebase/Render/GitHub secrets and whichever message providers are enabled. Real identity and provider journeys remain unverified.
3. Run live staging multi-role/multi-school/multi-child journeys, session/factor recovery, private Storage and post-generation authorization checks. Automated fixtures cannot certify the selected cloud configuration.
4. Run representative multi-user load/soak, replica and pooler failure, cloud restore/PITR/object/key recovery, release/rollback and on-call drills. Local synthetic evidence is not all architecture performance targets.
5. Obtain actual school privacy/consent/retention/attendance/grading/security policy approvals, manual screen-reader/tablet review and independent security acceptance. Operational purge retains global identities and required audit/contract records; it is not blanket legal erasure.
6. A local Docker build encountered a resource/engine failure during image unpacking. Application production builds passed separately. A successfully executed release container and remote CI/Trivy result remain unverified.

A licensed Fabric Grotesk asset was not supplied. The site uses it when locally available, with the documented sans-serif fallback. Provider delivery is at least once, with target dedupe and stable idempotency where supported. Hardware, firmware queue/power-loss/RTC/OTA work is deferred and is not a website completion gate.


## Record-first invitations follow-up

Migration 023 adds record-bound onboarding after the 22-migration audit implementation. Parents require a child link; students and school staff require their own record email; Principal is a staff role. Invitation acceptance links the exact selected profile atomically and rechecks its school, role, email, active status and existing account ownership. Older unbound invitations must be cancelled/reissued. First-administrator bootstrap remains a restricted exception. See ACCOUNT_ONBOARDING.md. No remote migration or real invitation is performed by this follow-up; website services remain stopped outside disposable tests. The latest targeted verification is recorded separately in output/verification.json.
