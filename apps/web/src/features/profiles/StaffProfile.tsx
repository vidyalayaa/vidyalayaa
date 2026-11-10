import { lazy, Suspense, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { StaffProfile as StaffProfileData } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { display, label } from '../../lib/utils';
import { Badge, Empty, ErrorState, Loading, PageHeading } from '../../components/common';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { PersonAvatar } from './PersonAvatar';
import PhotoEditor from './PhotoEditor';
import PersonDetailsForm, { emergencyFields, professionalFields } from './PersonDetailsForm';

const CoreForm = lazy(() =>
  import('../resources/ResourceScreen').then((m) => ({ default: m.ResourceForm })),
);

function ProfileFields({ fields }: { fields: [string, string | number | null | undefined][] }) {
  return (
    <dl className="grid gap-4 sm:grid-cols-2">
      {fields.map(([key, value]) => (
        <div key={key}>
          <dt className="text-xs text-stone-500">{key}</dt>
          <dd className="mt-1 break-words text-sm">{value ?? 'Not recorded'}</dd>
        </div>
      ))}
    </dl>
  );
}

function StaffProfileContent({ id }: { id?: string }) {
  const a = useAuth();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<'core' | 'details' | 'photo'>();
  const canEdit =
    id &&
    a.me?.school?.role === 'school_admin' &&
    a.me.school.permissions.includes('teachers.write');
  const q = useQuery({
    queryKey: [a.school, 'staff-profile', a.me?.id, id || 'me'],
    queryFn: ({ signal }) =>
      api<StaffProfileData | null>(`/profiles/staff/${id || 'me'}`, { signal }),
  });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const staff = q.data;
  if (!staff)
    return (
      <Empty
        title="Staff profile not linked"
        description="Ask your School Admin to link your account to your staff record."
      />
    );
  const { details } = staff;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-lime-200 bg-lime-50 p-5">
        <PersonAvatar
          kind="staff"
          id={staff.id}
          photo={staff.photo_id}
          name={staff.full_name}
          className="size-20 text-2xl"
        />
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-xl font-bold">{staff.full_name}</h2>
          <p className="break-words text-sm text-stone-600">
            {staff.staff_code} · {details.designation || label(staff.staff_role)}
          </p>
        </div>
        <Badge>{staff.status}</Badge>
      </div>
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            type="button"
            onClick={() => setEditing(editing === 'core' ? undefined : 'core')}
          >
            Edit staff record
          </Button>
          <Button
            variant="outline"
            type="button"
            onClick={() => setEditing(editing === 'details' ? undefined : 'details')}
          >
            Edit profile details
          </Button>
          <Button
            variant="outline"
            type="button"
            onClick={() => setEditing(editing === 'photo' ? undefined : 'photo')}
          >
            Manage photo
          </Button>
        </div>
      )}
      {canEdit && editing === 'core' && (
        <Suspense fallback={<Loading />}>
          <CoreForm
            resource="teachers"
            initial={{ ...staff }}
            done={async () => {
              setEditing(undefined);
              await qc.invalidateQueries({ queryKey: [a.school] });
            }}
          />
        </Suspense>
      )}
      {canEdit && editing === 'details' && (
        <div className="rounded-2xl border border-line bg-white p-4">
          <PersonDetailsForm
            kind="staff"
            id={staff.id}
            initial={details}
            onDone={() => setEditing(undefined)}
          />
        </div>
      )}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {canEdit && editing === 'photo' && (
          <div className="min-w-0 lg:row-span-2">
            <PhotoEditor kind="staff" id={staff.id} photo={staff.photo_id} />
          </div>
        )}
        <section className="rounded-2xl border border-line bg-white p-5">
          <h3 className="mb-4 font-semibold">Professional information</h3>
          <ProfileFields
            fields={[
              ['Employee ID', staff.staff_code],
              ['Staff role', label(staff.staff_role)],
              ...professionalFields.map(
                ({ key, label: name }): [string, string | number | undefined] => [
                  name,
                  key === 'joined_on' && details[key] ? display(details[key]) : details[key],
                ],
              ),
            ]}
          />
        </section>
        <section className="rounded-2xl border border-line bg-white p-5">
          <h3 className="mb-4 font-semibold">Contact and emergency information</h3>
          <ProfileFields
            fields={[
              ['Official email', staff.email],
              ['Contact number', details.contact_phone],
              ['Address', details.address],
              ...emergencyFields.map(({ key, label: name }): [string, string | undefined] => [
                name,
                details[key],
              ]),
            ]}
          />
        </section>
      </div>
      {staff.staff_role === 'teacher' && (
        <section className="rounded-2xl border border-line bg-white p-5">
          <h3 className="mb-3 font-semibold">Assigned classes and subjects</h3>
          {staff.assignments.length ? (
            <ul className="divide-y divide-line">
              {staff.assignments.map((row, index) => (
                <li className="break-words py-2 text-sm" key={index}>
                  Class {row.grade} · Section {row.section} · {row.session_name}
                  {row.subject ? ` · ${row.subject}` : ''}
                  {row.class_teacher ? ' · Class teacher' : ''}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-stone-600">No current assignments.</p>
          )}
        </section>
      )}
    </div>
  );
}

export function StaffProfileDialog({ id, close }: { id: string; close: () => void }) {
  return (
    <Dialog
      open
      title="Staff profile"
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <StaffProfileContent id={id} />
    </Dialog>
  );
}

export default function StaffProfile() {
  return (
    <>
      <PageHeading
        title="My profile"
        description="Your official staff record, contact details and current teaching assignments."
      />
      <StaffProfileContent />
    </>
  );
}
