# Super Admin website verification — 21 October 2026

Scope: the current Super Admin website, its API workflows, and the authorization/database controls needed by those workflows. Firmware development, real reader provisioning, cloud deployment, and changes to the configured Supabase project were excluded. Billing remains manual.

## Results

- 34 distinct platform browser scenarios passed across desktop Chrome and an iPhone-sized Chromium viewport.
- 22 additional authentication, MFA and initial-administrator browser scenarios passed across those viewports.
- 43 API/database regression tests passed.
- Production builds passed for shared contracts, API, worker and website, including their TypeScript checks. Repository lint, embedded-secret checks and `git diff --check` also passed.
- The 34 platform scenarios were verified across a 32-pass run and a four-pass targeted rerun. The two original failures expected the hidden desktop search on mobile; the corrected tests exercise the mobile search and menu. Two desktop scenarios overlap between those runs and are counted only once.
- Earlier exploratory runs exposed genuine defects listed below; failing checks were corrected and rerun.

## Website coverage

| Area                    | Executed verification                                                                                                                                                                            | Test boundary                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Navigation              | School search, URL search state, platform notices, mobile menu, platform navigation for an account that also holds a Parent membership                                                           | Actual website and API                                                                        |
| Schools                 | Create a school with its initial trial subscription; prepare first School Admin invitation; reopen and cancel invitation                                                                         | Actual API/database; email provider simulated                                                 |
| Manual subscriptions    | Save/reopen plan, status, school limits and payment reference; require terminal export deadline; cancel and reactivate                                                                           | Actual API/database                                                                           |
| Campus groups           | Create a group beyond the first 100 sorted groups; search, assign, retain selection on reopen, remove assignment                                                                                 | Actual API/database                                                                           |
| Device inventory        | Validate input, register a reader, show one-time credentials, rotate credentials, revoke, reject rotation after revocation                                                                       | Actual API/database; hardware excluded                                                        |
| Support requests        | Show the school question, respond, resolve, verify saved status/response                                                                                                                         | Actual API/database                                                                           |
| Support access          | Request a scoped grant, deny unapproved access, require school approval, display approved records, deny other scopes, revoke, reject subsequent access                                           | Actual API/database; school decisions submitted through real API                              |
| Support expiry          | Remove displayed private records when a grant expires                                                                                                                                            | Browser with controlled API responses and clock                                               |
| School closure          | Request closure, require school approval, close school, change legal hold, block early deletion, return 404 for unknown closure job                                                              | Actual API/database; disposable schools only                                                  |
| Deletion request        | Explicitly confirm and queue an eligible deletion request                                                                                                                                        | Actual API/database; deletion worker never started                                            |
| Plans                   | Edit plan settings, persist values; verify audit behavior in API regressions                                                                                                                     | Actual API/database plus existing controlled-response UI tests                                |
| Usage                   | Render persisted school usage                                                                                                                                                                    | Actual API/database; snapshot collection not exercised                                        |
| Health                  | Render aggregate metrics and missing-worker state                                                                                                                                                | Actual API/database; no real worker started                                                   |
| Audit                   | Open change details; expose only approved before/after fields                                                                                                                                    | Actual API/database plus controlled-response browser test                                     |
| Firmware screen         | Open release metadata page                                                                                                                                                                       | Page/read endpoint only; publishing, rollout and hardware explicitly deferred                 |
| Permissions             | All 12 platform read endpoints reject School Admin, Principal, Teacher, Parent and Student; reject Super Admin at aal1; reject anonymous access; sample privileged writes denied to School Admin | Actual authentication middleware, API and database roles; trusted identity provider simulated |
| Session                 | Sign-out clears browser session and returns to login                                                                                                                                             | Website; logout provider response simulated                                                   |
| Google/password sign-in | Super Admin Google callback and enrolled MFA, unavailable provider fallback, password MFA, cancelled/missing callback, rejected PKCE exchange                                                    | Browser with simulated identity provider and API                                              |
| MFA settings            | QR rendering, duplicate-click prevention, interrupted enrollment recovery, unrelated-factor preservation, cleanup/listing failures and retry                                                     | Browser with simulated identity provider                                                      |

## Corrections made

1. Super Admin search now opens the school list with its search applied. The notification bell opens platform notices.
2. Accounts with both platform and school memberships retain platform URLs/navigation while using the platform console; family navigation does not appear there.
3. Campus selectors load for platform-only accounts, organization searches work beyond the first 100 records, and reopening the assignment dialog preserves its current group.
4. Support requests and notices use their own appropriate table columns. The response dialog displays the complete school question.
5. Subscription, plan, support-response and shared action dialogs wait for refreshed records before closing, preventing immediate reopening of stale values.
6. School action buttons wrap within their table cells instead of being clipped and obstructed by the previous cell; verified on desktop and mobile.
7. The deletion control stays disabled until closure, legal-hold and both retention deadlines permit a request. Completed/cancelled jobs cannot edit a legal hold; closure status refreshes periodically.
8. Credential rotation rejects revoked devices before changing credentials.
9. Closing an unknown offboarding job returns 404 instead of reporting a successful no-op.

No database migration was added. Existing user edits to validation error formatting and the academic navigation were preserved.

## Reproduce

Run from the repository root with Node 24.12 or newer within major version 24, dependencies installed, and Playwright Chrome available. These tests start and close isolated local services. Leave `NATIVE_FIXTURE_DATABASE_URL` unset; the new browser fixture explicitly rejects it.

```powershell
npx playwright test tests/e2e/platform-workflows.spec.ts tests/e2e/platform.spec.ts --workers=1
npx playwright test tests/e2e/platform-workflows.spec.ts --workers=1 --grep 'platform header search|explicit school role'
npx playwright test tests/e2e/mfa.spec.ts tests/e2e/google-login.spec.ts tests/e2e/onboarding.spec.ts --workers=1 --grep 'setup renders|restarts interrupted|stops on cleanup|rechecks factors|SUPER_ADMIN|unavailable Google|email/password|rejected PKCE|Google callback rejects|Super Admin can invite'
npx vitest run tests/api/invitations.test.ts tests/api/operations-controls.test.ts tests/api/offboarding.test.ts tests/database/schema.test.ts tests/database/ownership.test.ts
npm run build
npm run lint
npm run check:secrets
git diff --check
```

The second command was the targeted rerun for the corrected mobile test assumptions; it is unnecessary after a clean first command.

The new integrated fixture is `tests/e2e/fixtures/platform-app.ts`; its workflows are in `tests/e2e/platform-workflows.spec.ts`. It runs the actual Express application over all 23 repository migrations in disposable PGlite (PostgreSQL compiled to WebAssembly), using the runtime roles and RLS. The external Supabase identity and email services are simulated. Existing `platform.spec.ts` and authentication fixtures use controlled API/provider responses, so those checks establish browser behavior rather than live provider connectivity.

## Limits and production acceptance

These results apply to the checked-out source with the complete migration set in isolated tests. They do not establish that the configured cloud database has all migrations or that a separately running/deployed API uses this source.

Live Google OAuth, real MFA enrollment, email delivery, remote Supabase configuration, storage operations, background processing, backups, concurrent multi-connection behavior, and deployment were not certified by this task. No production data was deleted, no real invitation was sent, and no remote schema was changed. Firmware publication/rollout and physical ESP32 acceptance remain deferred as requested.
