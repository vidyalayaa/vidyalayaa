# Vidyalayaa

A school management SaaS built against the supplied Software Architecture Specification v1.0. React/TypeScript/Vite/Tailwind/shadcn-style Radix UI, React Router and TanStack Query; Express API; Supabase PostgreSQL/Auth/Storage; a separate notification/report worker; Firebase Hosting and Render deployment configuration.

The interface contains no simulated students, fees, devices or attendance. Without public connection settings it displays an explicitly labelled setup preview. Configured features use the authenticated API and authoritative database. Test fixtures are confined to tests and an explicitly opt-in development seed.

## Start

Requires Node.js 24 LTS and npm. From this directory:

```powershell
npm ci
npm run build -w @vidyalayaa/contracts
npm run dev -w @vidyalayaa/web
```

Open http://127.0.0.1:5173 for the setup preview. For real workflows configure each `.env` from its `.env.example`, initialize Supabase and provision the database roles as described in [the deployment guide](docs/DEPLOYMENT.md), then:

```powershell
npm run db:migrate
npm run db:verify
npm run dev
```

`npm run dev` starts web, API and worker separately. The API/worker intentionally fail configuration validation if credentials are absent. Never substitute a migration-owner or service-role database connection to make a production API start.

## Validate

```powershell
npm run typecheck
npm test
npm run build
npm run contracts
npm run check:secrets
npx playwright test tests/e2e/workspace.spec.ts tests/e2e/mfa.spec.ts tests/e2e/auth-callback.spec.ts tests/e2e/google-login.spec.ts tests/e2e/onboarding.spec.ts tests/e2e/school-workflows.spec.ts tests/e2e/platform.spec.ts --workers=2
```

Browser tests use installed Chrome locally; set PLAYWRIGHT_CHANNEL=chromium after `npx playwright install chromium` on Linux. The portable database tests execute PostgreSQL in WASM with forced RLS and real SQL. The separate multi-connection PostgreSQL suite requires a dedicated `_test` database:

```powershell
npx tsx scripts/prepare-test-db.ts
npm run db:migrate
npm run db:verify
npm run test:integration
```

For the last commands point both TEST_DATABASE_URL and MIGRATION_DATABASE_URL to that isolated test database and use DB_SSL=false only locally. CI supplies PostgreSQL 17 and runs the 1,000-iteration, five-device suite. Never run fixtures or load tests on production school records.

## School Admin and Principal accounts

Every role can use **Continue with Google** or email/password at `/login`. Configure the Google OAuth client, provider and callbacks using [Google sign-in setup](docs/GOOGLE_SIGN_IN.md). An enrolled authenticator is still required, and signing in never creates a school role. Until Google is configured, the page explains its unavailability and keeps email/password usable.

Super Admin signs in with MFA, opens **Schools**, and selects **Invite School Admin** for a new school. The recipient verifies the setup email, chooses a Vidyalayaa password and accepts the school invitation. Existing verified accounts accept in Settings with their current password. The School Admin then opens **Members & invitations** and invites the Principal and other school roles. All roles use `/login`; authorized portals are `/admin`, `/principal`, `/teacher`, `/parent`, `/student` and `/platform`.

An invitation does not expose school records until acceptance. Teacher assignments and parent/student profile links must be configured afterward. The last active School Admin is protected. See deployment section 6 for resending, cancellation and account recovery.

## Find your way

- [Implementation checklist and structure](docs/IMPLEMENTATION.md)
- [Completion audit and remaining work](docs/REMAINING_FEATURES.md)
- [Deployment and operational guide](docs/DEPLOYMENT.md)
- [API documentation](docs/API.md) and [generated OpenAPI](docs/api/openapi.json)
- [NFC device contracts](docs/DEVICE_API.md) and [firmware example](firmware/README.md)
- [Readiness and verification evidence](docs/READINESS.md)
- [Requirement traceability](docs/TRACEABILITY.csv)

Production deployment needs your Supabase/Firebase/Render/GitHub projects, secrets, verified notification providers and an approved school schedule. Actual online payment collection is deliberately not claimed: SAS v1 leaves payment-provider selection open. Firmware is an explicit prototype example; production signed OTA and secure provisioning remain implementation gates; hardware power-failure acceptance also requires physical validation. See the readiness ledger for precise limits.
