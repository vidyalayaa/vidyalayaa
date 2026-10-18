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
npx playwright test tests/e2e/workspace.spec.ts
```

Browser tests use installed Chrome locally; set PLAYWRIGHT_CHANNEL=chromium after `npx playwright install chromium` on Linux. The portable database tests execute PostgreSQL in WASM with forced RLS and real SQL. The separate multi-connection PostgreSQL suite requires a dedicated `_test` database:

```powershell
npx tsx scripts/prepare-test-db.ts
npm run db:migrate
npm run db:verify
npm run test:integration
```

For the last commands point both TEST_DATABASE_URL and MIGRATION_DATABASE_URL to that isolated test database and use DB_SSL=false only locally. CI supplies PostgreSQL 17 and runs the 1,000-iteration, five-device suite. Never run fixtures or load tests on production school records.

## Find your way

- [Implementation checklist and structure](docs/IMPLEMENTATION.md)
- [Deployment and operational guide](docs/DEPLOYMENT.md)
- [API documentation](docs/API.md) and [generated OpenAPI](docs/api/openapi.json)
- [NFC device contracts](docs/DEVICE_API.md) and [firmware example](firmware/README.md)
- [Readiness and verification evidence](docs/READINESS.md)
- [Requirement traceability](docs/TRACEABILITY.csv)

Production deployment needs your Supabase/Firebase/Render/GitHub projects, secrets, verified notification providers and an approved school schedule. Actual online payment collection is deliberately not claimed: SAS v1 leaves payment-provider selection open. Firmware is an explicit prototype example; production signed OTA and secure provisioning remain implementation gates; hardware power-failure acceptance also requires physical validation. See the readiness ledger for precise limits.
