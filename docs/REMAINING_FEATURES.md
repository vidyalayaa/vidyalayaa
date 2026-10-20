# Remaining verification and release work

Updated 20 October 2026. Use AUDIT_IMPLEMENTATION.md for each of the 28 audit packages and output/verification.json for executed counts. The original 239-row audit is historical; source fixes do not automatically verify every row.

The owner selected manual billing, retained Supabase Auth/database, and explicitly deferred firmware until website completion. All implementation packages use GPT-6.1 Sol. No online payment gateway is in the current scope.

## Implemented website work

Role-bound dashboards/portals and permissions; Google/password/MFA flows; school onboarding/invitations; scoped records and published results; report reauthorization; announcement audience/publication checks; entitlement/quotas; school security; parent privacy and push ownership; master-record import/retirement; movement/review history; school/Principal analytics; CSV/PDF and full-school exports; contractual closure/hold/purge; campus/usage controls; support intake/responses; manual subscriptions; platform credential/audit controls; durable throttles; privacy-filtered error monitoring; migration, backup and release tooling.

Local tests verify meaningful SQL/API/worker/browser paths, including cross-school and unrelated-child restrictions. Tests use isolated generated records. The configured application database has not received migrations 010-022 during this work.

## Remaining source/contract follow-up

- Specialized API response projections are not all separately generated Zod schemas. The shared resource/operation requests and expanded OpenAPI exist; a final route-by-route response contract and deeper controller/service/repository refactor remain explicit T16 follow-up. Do not call that portion fully verified.
- Full cloud monitoring/log-drain/on-call and selected SMS/vendor configuration depend on the intended accounts; provider adapters fail visibly when missing. The container scan is configured in CI; no remote scan success is claimed without an actual CI run.
- Manual assistive-technology/tablet review and an independent security assessment remain separate from automated browser/axe coverage.

## External acceptance before a live school release

1. Apply and verify the reviewed forward migrations in staging, provision non-bypass runtime logins, verify TLS, and run real Supabase Auth/Storage role journeys. Configure Google OAuth and verified invitation/recovery SMTP. Never paste secrets into a chat or source file.
2. Exercise each primary role, the documented teacher scope, multiple schools/children, account linking, invitation expiry/retries, factor recovery, session revocation and post-generation permission changes against staging identities.
3. Configure and validate email/FCM/SMS delivery, browser logout/token rotation, external timeout/retry behavior, quiet hours and on-call alert routing. A fixture/provider acceptance ID is not receipt/read evidence.
4. Approve actual school MFA/student-login, attendance, grading, privacy/notice/consent and retention/export/hold policies. Keep operational purge separate from legal erasure and managed backup aging.
5. Run the supplied 100-distinct-user morning-peak script, all PERF targets, query plans, pool headroom, provider/pooler failure and multi-hour soak on representative infrastructure. Local synthetic timings are not production SLO acceptance.
6. Configure managed PITR plus object/config/key recovery; complete a cloud restore and measure operational RPO/RTO. Local encrypted fixture restores do not prove Supabase Auth/Storage/PITR recovery.
7. Configure Firebase/Render/GitHub secrets and protected environments, run CI/image scanning, staging release/rollback and public headers/deep-link smoke tests. Promote only the reviewed identical API/worker/frontend commit.

## Deferred by owner

Embedded firmware development, board identification, physical queue/power-loss/RTC/OTA acceptance and field deployment. Existing firmware source is unfinished and must not be represented as an accepted production reader. The website/API contract stays available for later integration.
