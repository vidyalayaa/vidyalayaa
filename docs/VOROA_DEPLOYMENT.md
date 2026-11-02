# Voroa API deployment

The reported deployment built successfully but crashed during database-role validation with `SELF_SIGNED_CERT_IN_CHAIN`. The later port timeout is a consequence of that startup failure. Keep verified database TLS and the dedicated runtime logins; do not bypass the role check.

## Service settings

- Type: **Web Service**, runtime **Docker**.
- Repository: this monorepo; branch **main**, following the updated deployment choice. The earlier failed deployment used `newfeature`.
- Root directory: repository root (leave blank).
- Dockerfile: `/Dockerfile`.
- Health check path: `/health/ready`.
- Let Voroa supply `PORT` (currently `3000`). Remove an old `PORT=4000` override copied from Render. The API reads `PORT` and binds `0.0.0.0`.
- The Dockerfile starts the API with its own `CMD`. Voroa's separate Start command field does not override Docker `CMD`. Do not set a worker command for this web service.

## Runtime environment

Copy the server settings from `apps/api/.env.example`, using your existing protected values:

| Variable                    | Setting                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                  | `production`                                                                                          |
| `DB_SSL`                    | `true`                                                                                                |
| `DATABASE_URL`              | Dedicated `vidyalayaa_api` login, not the database owner                                              |
| `DEVICE_DATABASE_URL`       | Dedicated `vidyalayaa_device` login                                                                   |
| `PLATFORM_DATABASE_URL`     | Dedicated `vidyalayaa_platform` login                                                                 |
| `SUPABASE_URL`              | Existing Supabase project URL                                                                         |
| `SUPABASE_ANON_KEY`         | Existing publishable/anon value                                                                       |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only value, runtime only                                                                       |
| `TOKEN_ENCRYPTION_KEY`      | Existing shared API/worker key; do not rotate during the move                                         |
| `WEB_ORIGINS`               | Exact frontend HTTPS origins, comma-separated, with no trailing slash                                 |
| `DB_POOL_SIZE`              | Existing deployment limit (start small on a small Supabase project)                                   |
| `TRUST_PROXY_HOPS`          | Verify against Voroa's actual proxy topology before setting; do not blindly copy another host's value |

Delete `NODE_TLS_REJECT_UNAUTHORIZED=0` and `DB_SSL_REJECT_UNAUTHORIZED=false` if previously added. The application rejects these unsafe settings with an explicit message.

For ordinary Supabase `*.supabase.co` and `*.supabase.com` database hosts, the application trusts the bundled Supabase Root 2021 CA alongside Node's standard roots. For a project-specific CA, get the root certificate from Supabase **Database Settings → SSL Configuration** and set runtime `DB_CA_CERT` to the complete PEM, including the BEGIN/END lines. Both real multiline values and literal `\n` separators work. An explicitly configured CA must match the server; replace any stale or incomplete value. The certificate is public, but connection URLs and credentials remain private.

The application removes URL SSL options before passing a connection URL to node-postgres, because parameters such as `sslmode=require` otherwise replace the configured `ssl` object and discard its CA. Certificate and hostname verification stay on. `DB_CA_CERT` is the authoritative place to configure a custom CA, rather than URL certificate file parameters.

Secrets must be runtime values only. Voroa build-time variables become Docker build arguments; never expose server credentials or private keys there. No migrations, role creation or data changes are needed for this fix.

## Build and release

```powershell
npm run build -w @vidyalayaa/contracts
npx vitest run tests/unit/database-tls.test.ts
npm run build
```

Push the reviewed changes to the branch selected in Voroa, then use **Manual Deploy → Deploy latest commit**. Confirm the deployed revision contains the fix, not just that an older build succeeded. The log should show `Vidyalayaa API listening on 0.0.0.0:3000`, followed by a successful `/health/ready` check. A failed role check must be fixed by using the correct non-owner login; do not remove that check.

The worker remains a separate service. If you move it too, create a **Background Worker**. For a Docker worker, Voroa uses Docker `CMD`, so use a worker-specific Dockerfile with `CMD ["node", "apps/worker/dist/apps/worker/src/index.js"]` rather than relying on a Start command override. Apply the same verified TLS configuration to `WORKER_DATABASE_URL` and preserve existing notification credentials. This API fix does not change the worker's hosting or start it alongside the API.

## Connect the hosted frontend

Set the frontend's existing `VITE_API_URL` to the new API HTTPS origin **without `/api/v1`**, rebuild, and redeploy Firebase Hosting. The frontend appends `/api/v1` itself. Keep `VITE_SUPABASE_URL` and the public Auth key on the existing Supabase project. Never put the service-role key or database URLs in a `VITE_` variable.

`firebase.json` allows API connections to `https://*.getvoroa.com`. Deploy that configuration along with the new frontend build. If using a custom API domain, add that exact HTTPS origin to `connect-src` as well. `WEB_ORIGINS` on the API must include the actual frontend origin. Check browser developer tools for CSP or CORS failures if health checks pass but login/data requests fail.

## Verification and limits

The TLS regression tests exercise the actual installed PostgreSQL driver's parsing, including conflicting SSL URL parameters, custom certificates, provider host matching, preserved credentials, unsafe environment flags and production TLS enforcement. Read-only live connection verification and production build results are recorded in the task's completion report. A local build or connection test does not prove Voroa has deployed that revision; verify the running deployment and public health endpoints after rollout.

Verified on 2 November 2026: all 15 TLS regression tests and 10 schema/security tests passed on `main`. All eight read-only live checks passed for the API, device, platform and worker logins, both with ordinary URLs and with `sslmode=require`, using the bundled trusted certificates without `DB_CA_CERT`. The compiled API started in production mode on the supplied temporary port, bound `0.0.0.0`, and returned HTTP 200 from `/health/live` and `/health/ready`; the temporary verification process was then stopped. The full contracts/API/worker/website production build, lint, secret scanning and whitespace checks passed. No school records were changed. Docker image execution was not tested locally because Docker Desktop's engine was not running. Voroa settings and deployment status could not be verified because the computer-use tool stopped browser access when it could not confidently determine the current URL.

References: [Voroa Docker runtime and port/health contract](https://getvoroa.com/docs/docker/), [Voroa secret handling](https://getvoroa.com/docs/docker-secrets/), [node-postgres SSL URL precedence](https://node-postgres.com/features/ssl), [Supabase verified database TLS](https://supabase.com/docs/guides/platform/ssl-enforcement).
