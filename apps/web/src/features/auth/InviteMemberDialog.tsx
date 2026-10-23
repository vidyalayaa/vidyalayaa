import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InvitationCandidate, InvitationResult, Page, Role } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { schoolPath } from '../../lib/portals';
import { Dialog } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { ErrorState, Loading } from '../../components/common';
import Pagination from '../../components/Pagination';

export default function InviteMemberDialog({
  close,
  onResult,
}: {
  close: () => void;
  onResult: (value: InvitationResult) => void;
}) {
  const auth = useAuth(),
    client = useQueryClient();
  const [role, setRole] = useState<Role>('teacher');
  const [record, setRecord] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const candidates = useQuery({
    queryKey: [auth.school, 'invitation-candidates', role, page, search],
    queryFn: () =>
      api<Page<InvitationCandidate>>(
        `/invitation-candidates?role=${role}&page=${page}&search=${encodeURIComponent(search)}`,
      ),
  });
  const selected = candidates.data?.data.find((item) => item.id === record);
  const invite = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error('Choose an existing school record.');
      return api<InvitationResult>('/invitations', {
        method: 'POST',
        body: JSON.stringify({
          role,
          record_id: selected.id,
          email: selected.email,
          full_name: selected.full_name,
        }),
      });
    },
    onSuccess: (value) => {
      client.invalidateQueries({ queryKey: [auth.school] });
      onResult(value);
      close();
    },
  });
  const recordsPath =
    role === 'student' ? '/r/students' : role === 'parent' ? '/r/parents' : '/r/teachers';
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !invite.isPending) close();
      }}
      title="Invite an existing school member"
      description="Select a record already added to this school. Acceptance links the account to that exact record."
    >
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          invite.mutate();
        }}
      >
        <div>
          <label className="field-label" htmlFor="invitation-role">
            Role
          </label>
          <select
            id="invitation-role"
            className="input"
            value={role}
            disabled={invite.isPending}
            onChange={(event) => {
              setRole(event.target.value as Role);
              setRecord('');
              setPage(1);
              setSearch('');
              invite.reset();
            }}
          >
            <option value="teacher">Teacher</option>
            <option value="principal">Principal</option>
            <option value="parent">Parent</option>
            <option value="student">Student</option>
            <option value="school_admin">School Admin</option>
            <option value="finance_staff">Finance staff</option>
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="invitation-search">
            Find a school record
          </label>
          <input
            id="invitation-search"
            className="input"
            value={search}
            disabled={invite.isPending}
            placeholder="Search name, email or school code"
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
              setRecord('');
            }}
          />
        </div>
        {candidates.isLoading ? (
          <Loading />
        ) : candidates.error ? (
          <ErrorState error={candidates.error} retry={() => candidates.refetch()} />
        ) : (
          <>
            <div>
              <label className="field-label" htmlFor="invitation-record">
                Existing school record
              </label>
              <select
                id="invitation-record"
                className="input"
                value={record}
                required
                disabled={invite.isPending}
                onChange={(event) => {
                  setRecord(event.target.value);
                  invite.reset();
                }}
              >
                <option value="">Choose a record</option>
                {candidates.data?.data.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.full_name}
                    {item.code ? ` · ${item.code}` : ''} · {item.email}
                  </option>
                ))}
              </select>
            </div>
            <Pagination
              total={candidates.data?.total}
              page={page}
              pageSize={candidates.data?.page_size}
              onPage={(value) => {
                setPage(value);
                setRecord('');
              }}
            />
            {!candidates.data?.data.length && (
              <p className="notice" role="status">
                No eligible records on this page. Add an active record with an email first. Staff
                must have the selected role; parents must be linked to a child. Accounts already
                linked to a record are managed through memberships.
              </p>
            )}
          </>
        )}
        {selected && (
          <dl className="rounded-xl border p-4 text-sm">
            <dt className="field-label">Invitation recipient</dt>
            <dd>{selected.full_name}</dd>
            <dd className="break-all">{selected.email}</dd>
          </dl>
        )}
        <Link className="text-sm underline" to={schoolPath(recordsPath, auth.me?.school?.role)}>
          Add or update school records
        </Link>
        {invite.error && (
          <p className="field-error" role="alert">
            {invite.error.message}
          </p>
        )}
        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" disabled={invite.isPending} onClick={close}>
            Cancel
          </Button>
          <Button type="submit" variant="lime" disabled={!selected || invite.isPending}>
            {invite.isPending ? 'Sending invitation…' : 'Send invitation'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
