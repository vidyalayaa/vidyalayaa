# Vidyalayaa Security Audit Report

**Date:** 14 November 2026
**Type:** Read-only audit (static code review plus dynamic testing in an isolated sandbox database)
**Standards used:** OWASP Top 10 (2021), OWASP ASVS 4.0 as a checklist, OWASP API Security Top 10 (2023)
**Handling:** This report describes security weaknesses. Keep it private and do not commit it to a shared or public repository.

---

## 1. Executive summary

No Critical or High severity vulnerability was confirmed. I found no way, through the code I reviewed or the role tests I ran, for one school to read or change another school's data, for a parent or student to reach another family's records, or for a lower role to promote itself through the API. No SQL injection, stored or reflected XSS sink, CSRF exposure, or committed secret was found.

Nine findings were confirmed: two Medium and seven Low. One further item could not be verified because it depends on the live Supabase project settings, which were out of scope.

| ID | Severity | Finding | Status |
|----|----------|---------|--------|
| M-1 | Medium | Role assignment, member directory and audit log are protected only by API code; the database policies do not enforce them | Confirmed in sandbox and source |
| M-2 | Medium | Live owner-level credentials stored in plaintext on the development workstation, with the development seed guard switched off | Confirmed (local files); which environment they belong to not confirmed |
| L-1 | Low | Unauthenticated health endpoints query the database before any rate limiter and disclose the release commit | Confirmed in source |
| L-2 | Low | Learning-material uploads are not content-checked; bucket accepts generic binary types | Confirmed in source |
| L-3 | Low | One key (`TOKEN_ENCRYPTION_KEY`) is used for encryption, download signatures and rate-limit hashing, and shared by API and worker | Confirmed in source |
| L-4 | Low | CI actions and Docker base image are referenced by mutable tags | Confirmed in source |
| L-5 | Low | Known-vulnerable dependencies (two rated critical by npm, both development-only) | Confirmed by `npm audit` on the lockfile |
| L-6 | Low | Content-Security-Policy allows wildcard hosts in `connect-src` | Confirmed in source |
| L-7 | Low | Database defaults for the Supabase `anon`/`authenticated` roles are not pinned by migrations | Confirmed in source; live effect unverified |
| U-1 | Unverified (Low to Medium if present) | Self-signup and other hosted Auth settings are not enforced by the repository's configuration script | Needs a check on the live project |

**The most important action** is M-2: move the owner-level database URL and service-role key off the workstation's project folder (or rotate them if the folder has ever been shared, synced or backed up to a third party), and remove `ALLOW_DEVELOPMENT_SEED=true` from the file that holds the remote owner URL.

---

## 2. Scope, method and limitations

### 2.1 What you asked for and what was agreed

You asked for a complete read-only audit covering code, database, RLS, authentication, APIs, roles, storage, AI, sessions and multi-school isolation, with all six roles tested. When asked about live testing you chose **code plus local sandbox only**. Accordingly:

- Nothing was sent to the live Supabase project, the deployed API, Firebase, Render or Cloudflare. Credentials in the local `.env` files were never used to connect to anything.
- No code, migration, configuration or data in the project was changed. This report is the only file added to the project folder.
- Secret values were not copied into this report. Only variable names appear.

### 2.2 How the work was done

1. **Static review** of the API (`apps/api`), worker (`apps/worker`), web client (`apps/web`), shared contracts (`packages/contracts`), all 58 SQL migrations (`db/migrations`), scripts, CI workflows, Dockerfile, `render.yaml`, `firebase.json` and `supabase/config.toml`.
2. **Dynamic database testing** in a throwaway Postgres instance (PGlite, in-memory WASM Postgres from the project's own `node_modules`) built by applying every migration in order. Two synthetic schools were seeded, each with an admin, principal, two teachers, finance staff, two parents and two students, plus one platform Super Admin. Each probe ran as the real database role (`app_api`, `app_platform`, `app_device`, `anon`, `authenticated`) with the same session settings the API sets, inside a transaction that was rolled back.
3. **Secret scanning** of the working tree, all 63 commits of git history, the built web bundle, and the untracked `.tools`, `tmp`, `output`, `playwright-report` and `test-results` folders. Matching was done on patterns and on the actual local secret values (compared in memory, never printed).
4. **Dependency check** with `npm audit --package-lock-only` on a copy of the lockfile.

### 2.3 Limitations you should weigh

- **The deployed database was not inspected.** Everything said about RLS, grants and functions describes what the migrations produce. If the live database has drifted (manual changes, ad-hoc scripts such as those in `.tools`), those statements may not hold there. `npm run db:verify` exists for checking this and is worth running.
- **PGlite is not Supabase.** The sandbox used stub `auth` and `storage` schemas. Supabase-specific behaviour (default privileges, PostgREST exposure, Storage policies, Auth settings) was assessed from source only. See L-7 and U-1.
- **The API was not run end to end.** Role tests exercised the database layer directly with the API's session settings, and API authorisation was reviewed by reading the code. HTTP-level tests against a running instance were not performed.
- **Review depth varied.** The following were read in full or nearly so: `app.ts`, `lib/config.ts`, `lib/db.ts`, `lib/crypto.ts`, `lib/downloads.ts`, `lib/errors.ts`, `runtime-role.ts`, `middleware/auth.ts`, `middleware/security-events.ts`, `identity/sessions.ts`, `identity/invitations.ts`, `platform/billing.ts`, `school/academic-ai.ts`, `school/academic-intelligence.ts`, and the membership, invitation, report and material sections of `school/router.ts`. The following were reviewed by targeted search (route guards, SQL construction, storage calls, input schemas) rather than line by line: `fees.ts`, `promotion.ts`, `exports.ts`, `workflows.ts`, `parent-workspace`, `student-profile`, `person-profiles.ts`, `school-profile/router.ts`, most of `platform/router.ts`, `devices/ota.ts`, the worker modules, and the ESP32 firmware. A defect in business logic in those files could have been missed.
- **Parallel reviewer agents were unavailable** during this session (usage limit), so there was no independent second pass.
- The sandbox was reset partway through the session. The role-test results reported here were recorded before the reset; the M-1 policy definitions were re-confirmed against the migration source afterwards.

"No issue found" in this report means exactly that, within the limits above. It is not a guarantee of security.

---

## 3. Architecture as reviewed

Vidyalayaa is a multi-tenant school platform: a React/Vite single-page app on Firebase Hosting, an Express API and a background worker on Render, Supabase for Postgres, Auth and Storage, Firebase Cloud Messaging for push, ESP32 NFC readers for attendance, and Cloudflare Workers AI for academic guidance.

The request path is: bearer Supabase JWT, then `userAuth` (token validated server-side, account context loaded, MFA level and login-session liveness checked, `X-School-Id` accepted only if the user holds a membership there), then either the platform router (`platformOnly`: Super Admin plus MFA level 2) or `requireSchool` and `schoolAccess` followed by per-route `permission('code')` checks. Every query runs in a transaction that sets `app.school_id`, `app.user_id` and `app.actor_type`, and RLS policies key off those settings. The API connects as a non-owner, non-bypass role and refuses to start otherwise.

Roles present: Super Admin (platform), School Admin, Principal, Teacher, Parent, Student, and a seventh school role, **Finance Staff**, which was not in your list but was included in testing. The schema also defines platform roles SUPPORT and BILLING.

---

## 4. Findings

### M-1 (Medium): Role assignment, member directory and audit log rely on API checks alone

**OWASP:** A01 Broken Access Control, A04 Insecure Design. API1/API5 (object and function level authorisation).

**Affected:**
- `db/migrations/202610170001_initial.sql:173` policy `tenant` on `school_memberships`: `USING(school_id=app.school_id()) WITH CHECK(school_id=app.school_id())`
- `db/migrations/202610170001_initial.sql:433` policy `audit_tenant` on `audit_logs` (same shape)
- `db/migrations/202610170001_initial.sql:439` policy `user_self` on `users` (self, or any user who shares the current school)
- API guards that currently compensate: `apps/api/src/modules/school/router.ts:1564-1617` (`PATCH /memberships/:id`, requires `users.manage`, blocks self-change at line 1605), `:1497`, `:1524` (membership lists), `:1308` (`/audit`)

**Evidence (sandbox).** Running as database role `app_api` with the session settings the API would set for a given user in school A:

- `UPDATE school_memberships SET role_id = <school_admin role> WHERE user_id = <self>` affected 1 row when the session belonged to a **principal, teacher, parent or student**. Only the finance role was blocked (0 rows), because it alone has restrictive policies.
- A **student or parent** session could `SELECT` all 9 membership rows of the school, every `users` row of the school (email, full name, phone) and every `audit_logs` row of the school.
- With a school setting forged to a school the user does not belong to, `school_memberships` of that school was readable (9 rows), while `students`, `marks` and `parents` returned 0.

**What this means.** The platform's design leans on RLS as the last line of defence, and for pupil data it holds up well (section 5). For these three tables the policy only checks the school, not the caller's role. I found no API route that lets a non-admin reach them: membership changes require `users.manage` (School Admin only) and refuse self-changes, the audit route requires `audit.read`, and `X-School-Id` is validated against memberships. So this is **not exploitable through the reviewed API today**. The risk is that any future route, injection bug or logic slip that lets a member issue a write to `school_memberships` becomes an immediate escalation to School Admin, with no database backstop.

**Impact if a second bug appears:** full takeover of a school's administration by any member; disclosure of staff and parent contact details and the audit trail to students and parents.

**Safe reproduction (sandbox only).** Build a scratch database from `db/migrations`, seed one school with a teacher membership, then:

```sql
BEGIN;
SET LOCAL ROLE app_api;
SELECT set_config('app.school_id', '<school uuid>', true),
       set_config('app.user_id',   '<teacher user uuid>', true),
       set_config('app.actor_type','USER', true);
UPDATE school_memberships
   SET role_id = (SELECT id FROM roles WHERE code = 'school_admin')
 WHERE user_id = '<teacher user uuid>';   -- reports UPDATE 1
ROLLBACK;
```

**Recommended fix.**
1. Add restrictive policies on `school_memberships` for INSERT, UPDATE and DELETE that require the caller to hold `users.manage` in the current school (a helper equivalent to the check already inside `app.can_invite_member`), and that reject changes where `user_id = app.user_id()`.
2. Restrict SELECT on `school_memberships` and `users` to the caller's own row unless the caller holds a staff permission that needs the directory.
3. Restrict SELECT on `audit_logs` to callers holding `audit.read`.
4. Add integration tests asserting these denials for each role, alongside the existing RLS tests.

---

### M-2 (Medium): Owner-level live credentials in plaintext on the workstation, with the seed guard disabled

**OWASP:** A05 Security Misconfiguration, A07 Identification and Authentication Failures (credential handling). ASVS 2.10, 6.4.

**Affected (variable names only):**
- `.env` (project root): `MIGRATION_DATABASE_URL`, `DB_API_PASSWORD`, `DB_DEVICE_PASSWORD`, `DB_WORKER_PASSWORD`, `DB_PLATFORM_PASSWORD`, together with `NODE_ENV=development` and `ALLOW_DEVELOPMENT_SEED=true`
- `apps/api/.env`: `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `DEVICE_DATABASE_URL`, `PLATFORM_DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, `FIREBASE_SERVICE_ACCOUNT_BASE64`, `ACADEMIC_AI_CLOUDFLARE_TOKEN`
- `apps/worker/.env`: `WORKER_DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TOKEN_ENCRYPTION_KEY`, `FIREBASE_SERVICE_ACCOUNT_BASE64`
- `scripts/migrate.ts:26-31` (seed guard)
- `.tools/` (untracked): about twenty ad-hoc scripts that read `MIGRATION_DATABASE_URL` or the service-role key, for example `apply-fees.ts`, `apply-timetable.ts`, `recover-subject-migration.ts`, `school-profile-db.mjs`

**Evidence.**
- `MIGRATION_DATABASE_URL` points to a remote Supabase host over a direct connection as user `postgres`. That role owns the tables and is not subject to RLS. The four runtime URLs point to a remote Supabase pooler. The API's Supabase URL is the same project the built web app is configured for.
- In the same file, `NODE_ENV=development` and `ALLOW_DEVELOPMENT_SEED=true`. The guard in `scripts/migrate.ts` refuses `--seed` only when `NODE_ENV` is `production` or the allow flag is not `true`, so on this machine `npm run db:seed` would write development fixtures into whichever database that URL names.
- Positive results: none of these values appears in any of the 63 commits, in the built web bundle, in `output/vidyalayaa-source.zip`, or in the untracked tool, test and report folders (checked by exact-value match). `.gitignore` and `.dockerignore` both exclude `.env` files. The web bundle contains only the public anon key.

**Not verified.** I did not connect to anything, so I cannot state that the remote project is production. If it is a separate staging project, severity drops to Low. If it is the live project holding children's records, Medium is appropriate and arguably conservative.

**Impact.** Anyone or anything that can read this folder (malware, a compromised dev dependency, a cloud-sync or backup tool, a shared screen, an AI or editor plugin with file access) obtains unrestricted read/write access to every school's data, the ability to mint storage URLs and Auth sessions through the service-role key, and the key that decrypts stored push tokens. L-5 is relevant here: the two dependency advisories rated critical affect developer tooling that runs on this same machine. Separately, a mistyped command could seed or alter the remote database.

**Safe reproduction.** Inspect the three files and confirm the variable names and that the host in `MIGRATION_DATABASE_URL` is remote. Do not run the seed command.

**Recommended fix.**
1. Remove `MIGRATION_DATABASE_URL` and the service-role key from the workstation. Run migrations only from the deploy workflow (it already takes this value from GitHub environment secrets) or inject them per command from a password manager.
2. Point local `.env` files at a local or staging project.
3. Remove `ALLOW_DEVELOPMENT_SEED=true` from any file that contains a remote URL. Consider hardening the guard so it also refuses when the URL host is not `localhost`.
4. If this folder has ever been synced, zipped, shared or opened by untrusted tooling, rotate: the `postgres` password, the four runtime role passwords, the service-role key, the Firebase service account, the Cloudflare token and `TOKEN_ENCRYPTION_KEY` (the last needs a re-encryption plan for stored push tokens).
5. Retire the `.tools` one-off scripts that modify the database outside the migration runner, then run `npm run db:verify` to confirm the live schema matches the migrations.

---

### L-1 (Low): Health endpoints query the database ahead of all rate limiting

**OWASP:** API4 Unrestricted Resource Consumption, A05.

**Affected:** `apps/api/src/app.ts:88-113` (`/health/worker`, `/health/live`, `/health/ready`), registered before the first rate limiter at `:114-126`.

**Evidence.** `/health/worker` runs `SELECT app.worker_release_ready($1)` and `/health/ready` runs `SELECT 1` on the API pool for every unauthenticated request. Both responses include `release` (the git commit of the deployment).

**Impact.** A flood of requests to these paths consumes database pool connections with no throttle, which can degrade the API for real users. The commit hash is minor information disclosure.

**Safe reproduction.** On a local instance, request `/health/ready` repeatedly and observe that no `429` is ever returned, unlike `/api/v1/*`.

**Recommended fix.** Move the in-memory limiter above the health routes or give them a small dedicated limit, cache the readiness result for a few seconds, and drop `release` from the public response (or serve it only to the platform's health checker).

---

### L-2 (Low): Learning-material uploads are not content-checked

**OWASP:** A04 Insecure Design, A08 Software and Data Integrity. ASVS 12.1-12.4.

**Affected:**
- `apps/api/src/modules/school/router.ts:1753-1786` (`POST /materials/upload`): validates only the filename pattern, then returns a Supabase signed upload URL
- `apps/api/src/modules/school/router.ts:1787-1863`: download serves `Content-Type` from the stored object
- `db/migrations/202610200016_offboarding_exports.sql:64`: bucket limit raised to 20 MB and `application/json`, `text/csv`, `application/octet-stream` added to the allowed types
- `apps/web/src/features/materials/SubjectMaterials.tsx:351-353`: browser uploads straight to storage

**Evidence.** The server never sees the bytes. A teacher account can upload any content under a `.pdf` or image filename, with any content type the bucket accepts, including generic binary. Mitigations that are present and working: the path is fixed by the server to `<school>/materials/<class>/<uuid>-<name>`; the assignment's `storage_path` is validated to that prefix and rejects `..` (`resources.ts:419-429`), so it cannot point at another school's or another module's object; downloads are forced to `Content-Disposition: attachment` and Helmet sets `nosniff`, so the file is not rendered in the app's origin.

**Impact.** A compromised or malicious teacher account could distribute a harmful file to students and parents under a trusted school label. No cross-tenant or script-execution impact was found.

**Safe reproduction.** In a local environment, request an upload ticket for `notes.pdf`, upload a text file to the signed URL, attach it to an assignment and download it as a student: it is delivered unchanged.

**Recommended fix.** Give materials their own bucket restricted to PDF and image types, verify magic bytes after upload (the school-profile upload route already does a type check server-side and is a good model), consider malware scanning, and serve a fixed content type derived from the validated extension.

---

### L-3 (Low): One secret serves several cryptographic purposes

**OWASP:** A02 Cryptographic Failures. ASVS 6.2.

**Affected:** `apps/api/src/lib/crypto.ts:16` (AES-256-GCM), `apps/api/src/lib/downloads.ts:5,27` (HMAC download signatures), `apps/api/src/middleware/security-events.ts:14` (HMAC for rate-limit buckets), `apps/api/src/app.ts:136-166,200,202`, `apps/worker/src/index.ts:21,71`.

**Evidence.** `TOKEN_ENCRYPTION_KEY` is used directly for all three, and the API and worker hold the same value. The primitives are sound (random IVs, timing-safe comparison, 60-second download expiry bound to path, user and school).

**Impact.** No practical attack identified. The concern is blast radius: one leak compromises three controls, and the key cannot be rotated for one purpose without the others.

**Recommended fix.** Derive per-purpose subkeys with HKDF and distinct labels, and add a key-version prefix to ciphertexts so rotation is possible.

---

### L-4 (Low): Mutable references in the build pipeline

**OWASP:** A08 Software and Data Integrity Failures.

**Affected:** `.github/workflows/ci.yml:26,27,62,73,88,90` and `.github/workflows/deploy.yml:27,28,84` (`actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4`, `aquasecurity/trivy-action@v0.36.0`); `Dockerfile:1,11` (`node:24-alpine`).

**Evidence.** Tags can be moved by whoever controls the upstream repository. The deploy workflow exposes `MIGRATION_DATABASE_URL`, Render deploy hooks and a Firebase service account to its steps. Positive points: workflow permissions are `contents: read`, deploy is manual (`workflow_dispatch`) and environment-scoped, and the runtime image drops npm and runs as the non-root `node` user.

**Recommended fix.** Pin each action to a full commit SHA and the base image to a digest, and let Dependabot or Renovate propose updates.

---

### L-5 (Low): Dependencies with published advisories

**OWASP:** A06 Vulnerable and Outdated Components.

**Evidence.** `npm audit --package-lock-only` on a copy of the lockfile reported 11 advisories: 2 critical, 8 moderate, 1 low, all with fixes available.

| Package | npm severity | Reach |
|---------|--------------|-------|
| `vitest` (direct, `^3.2.4`), `tinypool`, `@vitest/mocker` | Critical / moderate | Development and CI only. Removed from the runtime image by `npm prune --omit=dev` (`Dockerfile:10`) |
| `gaxios`, `gcp-metadata`, `google-gax`, `rimraf`, `glob`, `minimatch` | Moderate | Transitive, through the Google/Firebase client libraries |
| `fast-xml-parser` | Low | Transitive |
| `postcss-selector-parser` | Moderate | Build tooling |

I rate this Low for the deployed service because the critical items do not ship. They do run on developer machines and CI, which is where the secrets in M-2 live, so they should not be left. I did not analyse whether the moderate transitive issues are reachable from application code.

**Recommended fix.** Run `npm audit fix`, upgrade `vitest` to a patched release, and consider failing CI on high or critical advisories.

---

### L-6 (Low): Wildcard hosts in the Content-Security-Policy

**OWASP:** A05 Security Misconfiguration.

**Affected:** `firebase.json:36`.

**Evidence.** `connect-src` allows `https://*.supabase.co`, `wss://*.supabase.co`, `https://*.onrender.com`, `https://*.getvoroa.com` and `https://*.sentry.io`. Anyone can create a project on the first two hosting domains. `style-src` includes `'unsafe-inline'`. The rest of the policy is strict: `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, plus HSTS, `X-Frame-Options: DENY` and `nosniff`.

**Impact.** No XSS was found, so this is not exploitable on its own. If script injection ever occurred, the wildcards would let stolen data be sent to an attacker-owned Supabase or Render project. This matters more because the Supabase session is held in `localStorage` (standard for this library, and read by `apps/web/public/theme-start.js:11`), where injected script could read it.

**Recommended fix.** Replace the wildcards with the exact project hostnames.

---

### L-7 (Low): Supabase default privileges are not pinned by the migrations

**OWASP:** A05 Security Misconfiguration.

**Affected:** `db/migrations/202610170001_initial.sql:503-504` (one-time `REVOKE ALL` from `anon`, `authenticated`, `PUBLIC`); no `ALTER DEFAULT PRIVILEGES` statement exists anywhere in `db/migrations`; `supabase/config.toml` exposes schema `public` through the Data API.

**Evidence.** The initial migration revokes table and sequence privileges that existed at that moment. Fourteen later migrations contain no explicit revoke for those roles. On hosted Supabase, tables created later in `public` may receive default grants to `anon` and `authenticated`. In the sandbox, both roles were denied on every table tested, all 78 `public` tables have RLS enabled and forced, and no policy names `anon`, `authenticated` or `PUBLIC`, so even with a table grant those roles would see zero rows and could write nothing. All 153 functions live in schema `app`, which is not exposed and grants no usage to those roles.

**Impact.** None found. This is a robustness gap: the day someone adds a table and forgets to enable RLS, the public Data API and anon key would expose it.

**Not verified.** The actual grants on the live project.

**Recommended fix.** Add a migration with `ALTER DEFAULT PRIVILEGES ... REVOKE ALL ... FROM anon, authenticated, PUBLIC` for tables, sequences and functions; re-run the blanket revoke; consider removing `public` from the Data API's exposed schemas, since the app never uses it; and add a CI check that fails if any `public` table lacks forced RLS.

---

### U-1 (Unverified): Hosted Auth settings are not enforced from the repository

**OWASP:** A07 Identification and Authentication Failures.

**Affected:** `scripts/lib/auth-config.mjs` (sets site URL, redirect allow-list, email confirmation, secure email and password change, minimum password length 12, OTP expiry), `supabase/config.toml` (`enable_signup = false`, applies to local development only).

**Evidence.** The script that configures the hosted project does not set the signup switch, leaked-password protection, session lifetime or inactivity timeouts, CAPTCHA, or Auth rate limits. Hosted projects allow signup by default, and the app offers Google sign-in. If signup is open, anyone could create an account using the public anon key. The trigger at `202610170001_initial.sql:505-509` would create a `users` row for them. By the code, such an account has no membership and no platform role, so it could call only `/api/v1/me`, its own invitations, and its own account and session routes. Email confirmation is enforced by the script, which prevents registering someone else's invited address.

**Impact if signup is open:** unwanted accounts, abuse of the project's email quota, and a larger authenticated attack surface. No data access path was identified.

**How to check safely.** In the Supabase dashboard under Authentication, confirm that new user signups are disabled for email and for Google, leaked-password protection is on, and session timeouts match your policy.

**Recommended fix.** Add these settings to `buildAuthConfig` so they are applied and reviewed with the rest.

---

## 5. Role testing results

All probes ran in the sandbox database as the runtime role with the API's session settings. "Denied" means zero rows returned or affected, or an explicit error.

### 5.1 Cross-school isolation (user of school A targeting school B)

| Role | Read B's students, marks, parents, teachers, classes, fees, attendance, audit log, invitations, memberships | Write into B |
|------|------|------|
| School Admin | Denied (0 rows on all ten tables) | Denied (RLS violation when moving or inserting a student into B) |
| Principal | Denied | Not attempted beyond reads |
| Teacher | Denied | Not attempted beyond reads |
| Finance Staff | Denied | Not attempted beyond reads |
| Parent | Denied | Not attempted beyond reads |
| Student | Denied | Not attempted beyond reads |
| No school context | 0 rows everywhere; `users` returns only the caller's own row | n/a |

### 5.2 Access within a school

| Role | Result |
|------|--------|
| **Super Admin** | API requires platform role `SUPER_ADMIN` and MFA level 2 on every platform route (`platform/router.ts:31`, `devices/ota.ts:74`). At the database, the platform role has grants on 20 tables and none on students, marks, parents, users, memberships or fees; pupil tables returned nothing. Support access to a school needs a time-limited grant approved by that school's admin. |
| **School Admin** | Full control of own school as designed. Cannot edit the subscription, cannot change own role (API), last-admin trigger prevents removing the final admin, audit log cannot be updated or deleted (append-only for the API role). |
| **Principal** | Read-mostly permission set; no `users.manage`, no `audit.read`. See M-1 for the database-layer gap. |
| **Teacher** | Cannot read students or marks of a class they are not assigned to. Updating a mark on a published exam raises `TEACHER_MARK_ACCESS_DENIED`. See M-1. |
| **Finance Staff** | Fees and notifications only. Membership self-promotion blocked at the database (restrictive policies exist for this role). |
| **Parent** | Cannot read another family's child, marks or parent record. Mark updates affect 0 rows. See M-1. |
| **Student** | Cannot read another student or their marks. Mark updates affect 0 rows. AI study-progress route is bound to the student's own record. See M-1. |
| **Device (NFC reader)** | Scoped to its own school; grants limited to 21 attendance and device tables. |
| **`anon` / `authenticated`** | Permission denied on every table tested. |

### 5.3 Structural checks

- RLS: 78 of 78 `public` tables enabled and forced. Schema `app`: 7 tables, all enabled, 6 forced (`app.platform_daily_notifications` is enabled but not forced; only the owner holds privileges on it, so this is informational).
- Functions: 153 in schema `app`, 95 `SECURITY DEFINER`, all with a pinned `search_path`, none executable by `anon` or `authenticated`. No functions in `public`. No views.
- Runtime roles are `NOLOGIN NOBYPASSRLS` group roles; the API refuses to start on a superuser, bypass-RLS or owner connection.

---

## 6. Areas reviewed with no finding

These are observations from the review described in section 2, not guarantees.

| Area | What was observed |
|------|-------------------|
| **SQL injection** | Values are parameterised throughout the API and worker. The few interpolated identifiers come from fixed maps or zod enums (`homework.ts:65`, `platform/router.ts:863`, `person-profiles` table selector, resource column names from strict schemas). Note that because RLS trusts session settings the API role can set, an injection bug would break tenant isolation, so this property is worth protecting with a lint rule. |
| **XSS** | No `dangerouslySetInnerHTML`, `innerHTML`, `eval` or `srcDoc` in the web source. External links are limited to `https://` by server-side schema (`contracts/src/index.ts:354-360`) and use `rel="noopener noreferrer"`. AI output is schema-validated text rendered by React. |
| **CSRF** | The API authenticates only by `Authorization` bearer header; no cookies are used, so cross-site requests carry no credentials. CORS is an allow-list from `WEB_ORIGINS`. |
| **Authentication and sessions** | Tokens are verified server-side on every request; login sessions can be listed and revoked and are checked for liveness; MFA step-up applies to sensitive routes; the auth callback strips one-time credentials from the URL; post-login redirects are restricted to same-origin paths (`auth-return.ts`). |
| **Privilege escalation via API** | Membership changes need `users.manage`, use a strict schema, take a lock and reject self-changes. Invitations are authorised again inside the database function. |
| **IDOR** | Reports are bound to the requesting user; materials, student and class lookups go through scope helpers and RLS; AI routes resolve the learner through RLS-filtered queries. |
| **File storage** | Buckets are private with no client-facing storage policies; all access is server-signed. Download links are HMAC-signed, bound to path, user and school, and expire in 60 seconds. Profile photos are stored as JPEG at server-chosen paths. |
| **AI integration** | Only numeric statistics and subject indices are sent to Cloudflare; no names, identifiers or free text. User questions are mapped to fixed topics rather than forwarded, which removes the prompt-injection path. Output is length-limited and schema-validated. Calls are rate-limited (8 per minute) and concurrency-capped. The provider token is server-side only. |
| **Billing webhook** | Disabled when no secret is set; otherwise HMAC-SHA256 over timestamp and raw body, 5-minute window, timing-safe compare, strict schema, idempotent apply. |
| **Device API** | Per-device random secret compared by hash in constant time; payload device id must match the authenticated device; firmware is size and SHA-256 checked before serving; firmware refuses to boot without secure boot and flash encryption and pins a CA certificate. |
| **Error handling and logging** | Unknown errors return a generic message with a request id. Logs redact the `authorization` and `cookie` headers. |
| **Exports** | CSV cells beginning with `=`, `+`, `-` or `@` are neutralised (`worker/src/reports.ts:124-131`). |
| **Secrets in source control** | None in the working tree, in 63 commits of history, in the web bundle or in the packaged source zip. The web bundle contains only the public anon key. No source maps are published. |

---

## 7. Remediation checklist

**Do first**

- [ ] M-2: Remove `MIGRATION_DATABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from workstation `.env` files; use a local or staging project for development.
- [ ] M-2: Delete `ALLOW_DEVELOPMENT_SEED=true` from the root `.env`; make the seed guard refuse non-local hosts.
- [ ] M-2: Decide whether the folder may have been exposed. If yes or unsure, rotate the database passwords, service-role key, Firebase service account, Cloudflare token and encryption key.
- [ ] U-1: In the Supabase dashboard, confirm signups are disabled (email and Google) and review session and password-protection settings.
- [ ] Run `npm run db:verify` against the live database to confirm it matches the migrations this audit was based on.

**Next**

- [ ] M-1: Add role-aware restrictive RLS policies on `school_memberships` (writes need `users.manage`, no self-change), and narrow SELECT on `school_memberships`, `users` and `audit_logs`.
- [ ] M-1: Add per-role integration tests for those denials.
- [ ] L-5: Run `npm audit fix` and upgrade `vitest`; gate CI on high and critical advisories.
- [ ] L-7: Add `ALTER DEFAULT PRIVILEGES` revokes and a CI check for forced RLS on every `public` table; consider un-exposing `public` from the Data API.

**Then**

- [ ] L-1: Rate-limit or cache the health endpoints and remove the commit hash from public responses.
- [ ] L-2: Separate, stricter bucket for materials; verify file signatures; consider malware scanning.
- [ ] L-3: Derive per-purpose subkeys from `TOKEN_ENCRYPTION_KEY`; add key versioning.
- [ ] L-4: Pin GitHub Actions to commit SHAs and the Docker base image to a digest.
- [ ] L-6: Replace CSP wildcard hosts with exact hostnames.
- [ ] Retire the one-off database scripts in `.tools`.

**Follow-up testing worth commissioning**

- [ ] HTTP-level tests of all roles against a running staging stack (this audit tested roles at the database layer and reviewed API guards by reading).
- [ ] Line-by-line review of the modules listed in section 2.3 as search-reviewed, with priority on fees, promotion, exports and workflows.
- [ ] A read-only configuration review of the live Supabase project (grants, storage policies, Auth settings), if you are willing to allow that.
