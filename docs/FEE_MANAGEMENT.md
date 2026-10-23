# Fee management

## Implementation checklist

- Class-wide fee versions with same fees across existing sections or separate fees for every section.
- Tuition, admission, examination, annual and custom categories; transport is assessed only through an explicit student service assignment.
- Monthly, quarterly, half-yearly, annual and one-time installments, bounded by the academic year and applicable enrollment/service dates.
- Academic year → class → section → student selection, assessed fees, paid amounts, balances, upcoming dates and overdue indicators.
- Manual payments with payment date, method, reference, notes, recorded staff member and allocations to one or multiple academic/transport installments.
- Unique receipts, durable retry protection, confirmation before payment, printable receipts and Save as PDF through the browser's print dialog.
- Append-only full payment reversals, replacement payments and reasoned voids for unpaid assessments.
- Read-only linked-child parent statements and student statements using the same assessments/payment ledger as staff.
- Collection summaries, class/section/year/category/student/receipt filters, date-wise collections and Excel-compatible CSV export.
- Backend authorization, forced tenant RLS, database balance/immutability guards and upgrade/regression/browser tests.

## Where to use it

The existing **Fees** sidebar link (`/{portal}/r/fee_records`) opens this module. School Admin and finance staff can manage fees. Principal retains school-wide read access. Parents see active linked children only; students see their own records. Teachers have no fee access.

The School Admin dashboard includes a fee summary. The parent dashboard links to the child's full statement and receipts. Existing student-profile collection links open the same payment workflow. No browser receives database credentials, privileged keys or payment-write privileges.

### Finance staff onboarding

School Admin adds a record in **School staff** with `staff_role=finance_staff`, the staff member's email and name. In **Members & invitations**, select **Finance staff** and that exact existing record. Existing invitation acceptance binds the account to the staff record. Finance staff sign in through the current authentication system and use `/finance`; they receive only `fees.read` and `fees.write`, without academic administration or user management permissions. Existing school MFA requirements apply to this privileged role as well. Do not change a teacher's role merely to enable fee access unless that is the intended staff duty.

School Admin may supply a custom receipt number before posting. Finance staff receive automatically generated receipt numbers. An issued receipt cannot be edited in place: reverse its payment with a reason and record a replacement payment. Receipt numbers remain reserved even after reversal.

## Class fee configuration and assessment

Choose the academic year and class, then **Class fee structures**. Select either **Same fee for all sections** or **Different fees by section**. The first mode configures each category once and records the existing section targets; the second requires fee items for every section. New sections added later require a new structure version before assessment.

Amounts are **per installment**, in INR. Monthly/quarterly/etc. schedules start at the first due date and repeat through the academic year. A January 31 monthly schedule uses February's last day and then March 31, avoiding month-end drift. Only installments within a student's applicable active enrollment dates are assessed.

Saving creates an immutable version with an optimistic version check. It does not change any posted student charge or payment. Select a section and optionally one student, then **Preview & assess fees**. Confirmation displays the new installment count and total. Repeated assessment skips existing active semantic charges for that student/year/category/label/due date, even when a later structure version changes the amount. For a deliberate correction, void the unpaid assessment with a reason, save the corrected structure version and explicitly preview/reassess. The voided record is retained while its active semantic slot becomes available for the replacement. Do not relabel or change dates merely to bypass duplicate prevention.

Existing fee records remain available. Their class for reports is resolved from their dated academic-year enrollment when no original class snapshot exists. Historical structures and student statements remain selectable by academic year.

## Payments, corrections and accounting

All payments here are **manual school collections**, not payment-gateway charges. Record only money actually received and verified by authorized staff. UPI, card, bank transfer and cheque entries require a transaction/cheque reference. A cheque should be posted only after verification/clearance under the school's collection procedure; reverse it if later dishonoured.

Select a student, choose **Record payment**, allocate amounts to outstanding installments, review the confirmation and post. Mixed academic and transport allocations may share one receipt when they use the same currency. Different currencies require separate receipts and are shown as separate totals. Payment dates cannot be in the future.

Receipt snapshots retain school/student details, student code, the available roll/class/year, payment breakdown, payment date/method/reference, staff name and the academic-year balance immediately after posting. Current balances may subsequently differ because of new assessments, payments or reversals. Browser **Print / save PDF** provides printing and PDF download without sending private receipt data to an external service.

Money is validated to two decimal places. Node calculations use integer cents and PostgreSQL uses `numeric(12,2)`. A payment's allocations must equal its header total at transaction commit. Row locks on assessments prevent concurrent overpayments; shared advisory locks serialize payment allocations/reversals and student/year account changes so concurrent payments against different installments retain correct receipt balance snapshots. Payment rows and allocations cannot be updated or deleted by the API role.

`fee_records.amount_paid` and status are a database-maintained projection of non-reversed allocation records, preserving compatibility with student profiles, existing fee reports and notifications. Clients cannot set paid totals or change posted history through generic CRUD. Use a **full reversal** with a reason, followed by a corrected replacement payment. The original payment and receipt stay visible, marked reversed. Partial correction is represented by reversing and replacing the full original payment with the correct allocations.

Generic payment retry keys expire after the existing retention window, but the ledger also retains a permanent per-school/user payment key and request fingerprint. Retrying an identical committed payment returns the same receipt; changed contents conflict. Receipt uniqueness is case-insensitive within each school. Use a fresh key for a deliberate new payment.

### Transport

Create routes/services under **Transport routes**, then select a student and choose **Assign transport**. Specify the route, agreed installment price/frequency, service start/end and first due date. The price is snapshotted on the assignment; later route edits do not reprice old charges. Overlapping transport assignments in the same academic year are rejected.

Only assigned students receive transport charges. **End service** records a reason and last service date and voids unpaid installments due after that date. Payments on future installments must be reversed first. Already-paid history is never erased. This implementation charges complete scheduled installments by due date; it does not silently prorate a partly used month. A school-authorized adjustment can be made using a reasoned void/replacement assessment.

## Reports

**Dashboard & reports** shows expected, paid, outstanding and overdue amounts. Filter by year, class, section, student, category and student/admission/class/receipt search. Date filters apply to date-wise collected payments and transaction exports; they do not hide outstanding assessed liabilities from year totals. Reversed payments and historical opening balances are excluded from new collection reports; statements still show their full retained history.

The CSV export opens in Excel and includes allocations, receipt numbers/dates/methods/references, staff names and reversals. Assessment totals repeated on transaction-allocation rows must not be summed as new charges: use the authoritative dashboard assessment totals. Exports escape spreadsheet formula prefixes and allow at most 10,000 rows per filtered download; narrow filters for larger datasets. Pagination is used for student choices and report records.

## Data and API

`fee_records` remains the assessment source. New tables:

- `fee_structures`, `fee_structure_sections`, `fee_structure_items`: immutable class structure versions and targeted sections.
- `fee_transport_routes`, `fee_transport_assignments`: services and student price/date snapshots.
- `fee_payments`, `fee_payment_allocations`, `fee_payment_reversals`: immutable receipt ledger and correction trail.

All tenant tables force RLS. Browser `anon`/`authenticated` and platform roles have no direct ledger grants. Runtime read policies check school membership and current ownership/family links; runtime writes require School Admin or finance staff. Trusted migration/restore owners retain maintenance access. Finance staff are prevented from writing academic records by database policies as well as API permissions. New private helper functions are security invokers and are not exposed through browser RPCs. Existing approved, unexpired Super Admin support grants retain read access only when their scope explicitly includes fees.

Endpoints below use `/api/v1`, verified bearer authentication and `X-School-Id`. See the generated [OpenAPI contract](api/openapi.json).

| Endpoint                                                      | Purpose                                                                                                                                             |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /fees/options`                                           | Accessible academic years and classes/sections                                                                                                      |
| `GET /fees/students?academic_session_id=…&grade=…&class_id=…` | Paginated authorized students                                                                                                                       |
| `GET /fees/students/{id}?academic_session_id=…`               | Complete authoritative statement, transport and receipts                                                                                            |
| `GET /fees/payments/{id}`                                     | Authorized receipt and reversal status                                                                                                              |
| `GET /fees/structures?academic_session_id=…&grade=…`          | Paginated retained fee versions                                                                                                                     |
| `POST /fees/structures`                                       | New fee version; `expected_version` protects stale changes                                                                                          |
| `POST /fees/assessments/preview` / `/fees/assessments`        | Preview/apply `{structure_id,class_id,student_id?}`                                                                                                 |
| `POST /fees/assessments/{id}/void`                            | `{reason}`; unpaid assessments only                                                                                                                 |
| `POST /fees/payments`                                         | `{student_id,academic_session_id,payment_date,payment_method,receipt_no?,reference,note,allocations:[{fee_id,amount}]}`; required `Idempotency-Key` |
| `POST /fees/payments/{id}/reverse`                            | `{reason}`; required `Idempotency-Key`                                                                                                              |
| `GET/POST /fees/routes`, `PATCH /fees/routes/{id}`            | Route configuration and availability                                                                                                                |
| `POST /fees/transport`                                        | Student service/price/date assignment and installments; required `Idempotency-Key`                                                                  |
| `POST /fees/transport/{id}/end`                               | `{ended_on,reason}`                                                                                                                                 |
| `GET /fees/reports` / `/fees/reports/export`                  | Staff-only summaries/records and `{filename,csv}` export                                                                                            |

Existing `/fees/{id}/pay` and `/fees/{id}/remind` contracts are retained; payment posting now uses the same ledger. Direct edits of paid totals are deliberately rejected.

## Migration, deployment and recovery

Migration: `db/migrations/20261023083655_fee_management.sql`. Never reset an existing school database to install this feature. Apply the migration before deploying the matching API, worker and frontend:

```powershell
npm run db:migrate
npm run db:verify
npm run build
npx vitest run
npx playwright test tests/e2e/fees.spec.ts tests/e2e/fees-roles.spec.ts --workers=1
```

Existing assessment IDs, amounts, dates, statuses and timestamps are retained. Reconciled pre-ledger payment audit receipts are imported with their existing receipt numbers. Any residual historical paid amount is explicitly labelled an **opening balance**, with unavailable original date/method clearly identified. Original audit logs remain unchanged. Legacy receipts are clearly labelled as reconstructed from retained audit and current school/student records; unavailable class/roll details are not invented. Review historical reconciliation on a backup/restored test database before production migration.

School exports now include every fee configuration/ledger table. Full database backups include the same tables. The approved offboarding purge function is extended in dependency order and retains its existing approvals, legal holds and export requirements; the fee module does not add an independent deletion path.

Prefer forward migrations for rollback. Once payments are posted, do not drop ledger tables, edit applied migration files or revert to manually entered paid totals. A UI rollback may retain the ledger-backed compatibility payment endpoint. Restore only through the documented verified-backup procedure.

If installation reports `LEGACY_FEE_RECONCILIATION_REQUIRED`, retained payment receipts exceed a manually entered historical paid total. Reconcile those original records with the school's accounts before retrying; the migration stops instead of dropping receipt history.

Tests use disposable databases and isolated browser auth fixtures; they do not charge money, send real setup emails or create live school test fees. Real authentication/provider configuration and deployment checks remain separate from isolated workflow verification.

### Additional concurrency checks

`npx vitest run --config vitest.integration.config.ts tests/integration/fees-concurrency.test.ts` exercises simultaneous payment retries, overpayments and reversals with separate PostgreSQL connections. It requires the existing disposable local `TEST_DATABASE_URL` setup and runs in CI after migration. It is skipped when that variable is absent. The local Docker engine was unavailable during this implementation, so these native multi-connection checks were not executed locally; the API/database suites use PostgreSQL in PGlite and serialized fixture connections.

### Verification record — 23 October 2026

- Production build passed for shared contracts, API, background worker and website. The existing mixed static/dynamic import warning remains non-blocking.
- Full regression: 227 tests passed across 39 files, including existing modules.
- Desktop/mobile workflow and role checks: 18 passed, covering payments, retry protection, receipts, reversals, transport, section-specific rates, exports and read-only family access.
- Historical upgrade test passed again after the final migration refinements, including preservation of actual receipt dates and refusal of inconsistent historical totals.
- Connected database migration applied transactionally; original assessment and school-settings fingerprints were unchanged, all eight new fee tables have RLS, and ledger reconciliation found zero mismatches. Browser payment insertion and API ledger overwrites are denied.
- Security advisors introduced no findings relative to the inspected baseline. Existing unrelated notices remain: five tables without policies, nine functions with mutable search paths, two extensions in public, and disabled leaked-password protection. See the [Supabase database advisor guidance](https://supabase.com/docs/guides/database/database-linter) and [password protection guidance](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).
- Four native PostgreSQL concurrency checks remain unexecuted locally and are included in CI; see the prerequisite above. Render/Firebase deployment and live provider sign-in were not performed by these isolated tests.
