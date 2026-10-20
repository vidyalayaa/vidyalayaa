# Existing-record account onboarding

Students, parents and staff are added before their login accounts are invited. Student roll numbers remain enrollment records; this change does not add roll-number login.

1. School Admin adds the student record, including the student's own email if a student login is needed. The record and its academic history do not require a login account.
2. Add the parent/guardian and their email, then link the parent to their authorized children in Family connections. At least one active child link is required to invite a parent.
3. Add teachers, Principals and additional School Admins in School staff. Supply staff code, name, email and the correct staff role. Teacher class/subject assignments determine the teacher's permitted records.
4. Open Members & invitations, select Invite member, select the role, and search/select an existing school record. The invitation email/name come from that record. There is no free-email invitation to a missing record.
5. The recipient verifies their email, signs in with password or configured Google, completes required MFA, and explicitly accepts the school invitation. Membership activation and linking the existing record to the verified account happen in one transaction.
6. Parents see authorized children, students see themselves, teachers see assigned classes/subjects and Principals see their permitted school information. Adding a record or matching an email alone never grants access.

## First administrator exception

Super Admin's existing first-School-Admin onboarding remains available before a new school has any staff records. This is restricted to the first administrator and cannot create Principal, teacher, parent or student access. Additional School Admin invitations use existing staff records.

## Migration and compatibility

Apply `202610200023_record_bound_invitations.sql` after the preceding reviewed migrations, then deploy the matching API and web build. Use `npm run db:migrate` followed by `npm run db:verify` with the migration-only connection. Back up the intended environment first; this task does not apply remote migrations or send real invitations.

The migration adds email fields to students/staff, staff roles, explicit same-school invitation foreign keys, and guarded database invitation functions. Existing linked identities are preserved. Existing linked student/staff emails and leadership staff roles are populated from their current accounts/memberships. A pending legacy invitation without a bound record must be cancelled and reissued against the correct record; it is never silently attached by email. An invalid/retired record, changed email/role, revoked parent-child link or conflicting account link blocks acceptance and leaves membership inactive. Decline/cancel remains available.

Accepted records are linked by their permanent IDs. Changing a roll number does not change identity/history. Editing a parent-child link or teaching assignment updates permitted visibility through the existing authorization checks.

## API

- `GET /api/v1/invitation-candidates?role=parent&page=1&search=name` returns paginated eligible records only from the selected authorized school; requires users.manage. Staff roles must match; parents need an active child link; email is required.
- `POST /api/v1/invitations` requires `{record_id, role, email, full_name}`. PostgreSQL validates the record, email and role and stores the canonical record name. Client input is never authority for account ownership.
- Resend preserves the bound record. Retargeting an active invitation requires cancellation first.
- Acceptance revalidates the selected record and atomically binds it to the verified invited user. Application database roles cannot invoke the older unbound helper functions.

Tests use disposable databases and isolated Auth/email fixtures. Real provider delivery and live staging identity acceptance remain separate checks.


Existing accepted accounts that lack a profile link are not automatically matched by email. A school administrator must review and explicitly link the correct existing account, or reissue onboarding against the selected record after resolving the old membership. Existing linked accounts and their history are preserved.

For rollback, retain accepted identity links and disable new invitations while reviewing the matching app/schema versions. Older clients do not send record_id and cannot create new school-member invitations under this migration. Do not restore the unbound helper grants to make an old client work. Database restoration, if needed, must use the reviewed backup and coordinated application version.
