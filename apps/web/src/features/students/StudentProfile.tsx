import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { GraduationCap, ShieldCheck, UserRound, UsersRound, Mail, School } from 'lucide-react';
import type { StudentProfile as Profile } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { genderLabel, label } from '../../lib/utils';
import { Badge, Empty, ErrorState, Loading, PageHeading } from '../../components/common';
import { Button } from '../../components/ui/button';
import { OwnProfileAvatar } from '../profiles/PersonAvatar';

function date(value: string | null | undefined) {
  return value
    ? new Date(value.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : 'Not recorded';
}
function Fields({ values }: { values: [string, ReactNode][] }) {
  return (
    <dl className="grid min-w-0 gap-x-6 gap-y-5 sm:grid-cols-2">
      {values.map(([name, value]) => (
        <div className="min-w-0" key={name}>
          <dt className="mb-1 text-xs font-medium text-stone-500">{name}</dt>
          <dd className="break-words text-sm font-medium text-stone-900">
            {value || 'Not recorded'}
          </dd>
        </div>
      ))}
    </dl>
  );
}
function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="min-w-0 rounded-3xl border border-line bg-surface p-5 sm:p-7"
    >
      <h2 className="mb-6 flex items-center gap-2 text-lg font-semibold">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}
export default function StudentProfile() {
  const a = useAuth(),
    allowed =
      a.me?.school?.role === 'student' && !!a.me.school.permissions.includes('students.read');
  const query = useQuery({
    queryKey: [a.school, a.me?.id, 'my-student-profile'],
    queryFn: () => api<Profile>('/student/profile'),
    enabled: allowed,
    staleTime: 0,
  });
  if (!allowed)
    return (
      <Empty
        title="Access unavailable"
        description="This page belongs to your student workspace."
      />
    );
  if (query.isLoading) return <Loading />;
  if (query.error) return <ErrorState error={query.error} retry={() => query.refetch()} />;
  if (!query.data)
    return (
      <Empty
        title="Profile unavailable"
        description="Ask your School Admin to link your account to your student record."
      />
    );
  const { student, school, enrollments, guardians, contact } = query.data,
    current = enrollments.find((e) => e.is_current),
    fullName = [student.first_name, student.last_name].filter(Boolean).join(' '),
    firstEnrollment = enrollments.at(-1);
  return (
    <>
      <PageHeading
        title="My profile"
        description="Your personal details, school records and family contacts, together."
      />
      <section
        aria-label="Student identity"
        className="mb-6 flex flex-wrap items-center gap-5 rounded-3xl border border-lime-200 bg-lime-50 p-6 sm:p-8"
      >
        <OwnProfileAvatar className="size-24 rounded-3xl bg-lime-300 text-3xl" decorative={false} />
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-stone-600">
            Your student record
          </p>
          <h2 className="break-words text-2xl font-bold sm:text-3xl">{fullName}</h2>
          <p className="mt-2 break-words text-sm text-stone-600">
            Admission no. {student.student_code}
          </p>
          <p className="mt-1 break-words text-sm text-stone-600">
            {school.name}
            {current ? ` · Class ${current.grade} · Section ${current.section}` : ''}
          </p>
        </div>
        <Badge>{student.status}</Badge>
      </section>
      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <Section title="Personal information" icon={<UserRound size={19} />}>
          <Fields
            values={[
              ['Full name', fullName],
              ['Student ID', student.student_code],
              ['Date of birth', date(student.date_of_birth)],
              ['Gender', genderLabel(student.gender)],
              ['Student status', <Badge>{student.status}</Badge>],
              ['Profile photo', 'Not recorded'],
            ]}
          />
        </Section>
        <Section title="Contact details" icon={<Mail size={19} />}>
          <Fields
            values={[
              ['Student email', student.email],
              ['Contact phone', contact?.contact_phone || student.phone],
              ['Address', contact?.address],
            ]}
          />
        </Section>
        <Section title="School & current enrollment" icon={<School size={19} />}>
          <Fields
            values={[
              ['School', school.name],
              ['School code', school.school_code],
              ['Class', current?.grade],
              ['Section', current?.section],
              ['Roll number', current?.roll_number],
              ['Academic session', current?.session_name],
              [
                'Enrollment status',
                current ? <Badge>{current.status}</Badge> : 'No current enrollment',
              ],
              ['Enrollment starts', date(current?.starts_on)],
              [
                'Enrollment ends',
                current
                  ? current.ends_on
                    ? date(current.ends_on)
                    : 'No end date recorded'
                  : 'Not recorded',
              ],
            ]}
          />
        </Section>
        <Section title="Parents & guardians" icon={<UsersRound size={19} />}>
          {guardians.length ? (
            <div className="space-y-6">
              {guardians.map((p, index) => (
                <div key={index} className={index ? 'border-t border-line pt-6' : ''}>
                  <h3 className="mb-4 break-words font-semibold">{p.full_name}</h3>
                  <Fields
                    values={[
                      ['Relationship', label(p.relationship.toLowerCase())],
                      ['Primary contact', p.is_primary_contact ? 'Yes' : 'No'],
                      ['Email', p.email],
                      ['Phone', p.phone],
                    ]}
                  />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-stone-600">
              No active parent or guardian details have been linked by your school.
            </p>
          )}
        </Section>
        <div className="lg:col-span-2">
          <Section title="Admission & enrollment records" icon={<GraduationCap size={19} />}>
            <Fields
              values={[
                ['Student ID', student.student_code],
                ['Admission date', 'Not recorded'],
                ['First recorded enrollment', date(firstEnrollment?.starts_on)],
              ]}
            />
            <p className="mt-4 text-xs text-stone-500">
              Enrollment dates are shown as recorded by your school. They do not establish a
              separate admission date.
            </p>
            <div className="mt-6 space-y-3">
              {enrollments.map((e, index) => (
                <article
                  key={index}
                  aria-label={`Enrollment: ${e.session_name}, Class ${e.grade}, Section ${e.section}`}
                  className="rounded-2xl border border-line bg-stone-50 p-4"
                >
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="break-words font-semibold">
                      Class {e.grade} · Section {e.section} · {e.session_name}
                    </h3>
                    <Badge>{e.status}</Badge>
                  </div>
                  <Fields
                    values={[
                      ['Record', e.is_current ? 'Current enrollment' : 'Enrollment record'],
                      ['Roll number', e.roll_number],
                      ['Starts', date(e.starts_on)],
                      ['Ends', e.ends_on ? date(e.ends_on) : 'No end date recorded'],
                      ['Academic session starts', date(e.session_starts_on)],
                      ['Academic session ends', date(e.session_ends_on)],
                    ]}
                  />
                </article>
              ))}
            </div>
            {!enrollments.length && (
              <p className="mt-5 text-sm text-stone-600">
                Your school has not recorded an enrollment yet.
              </p>
            )}
          </Section>
        </div>
      </div>
      <section
        aria-label="Profile corrections"
        className="mt-6 flex flex-wrap items-start gap-3 rounded-2xl border border-line bg-surface p-5"
      >
        <ShieldCheck className="shrink-0 text-lime-800" size={22} />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">Need a detail corrected?</h2>
          <p className="mt-1 text-sm text-stone-600">
            Your official profile is read-only. Contact your School Admin to request a correction to
            your personal, family or enrollment details.
          </p>
          {a.me?.school?.permissions.includes('attendance.correct_request') && (
            <Button asChild variant="outline" className="mt-4">
              <Link to="/student/corrections">Attendance correction requests</Link>
            </Button>
          )}
        </div>
      </section>
    </>
  );
}
