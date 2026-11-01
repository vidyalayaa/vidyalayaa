import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Building2,
  Pencil,
  Save,
  ImagePlus,
  ShieldCheck,
  Phone,
  Mail,
  Globe,
  Clock,
  ArrowLeft,
  FileText,
  Download,
  Trash2,
} from 'lucide-react';
import {
  schoolProfileUpdateSchema,
  type SchoolProfile as Profile,
  type SchoolProfileAsset,
  type SchoolProfileDetails,
} from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { useUnsavedChanges } from '../../lib/use-unsaved-changes';
import { Button } from '../../components/ui/button';
import { PageHeading, Loading, ErrorState, Empty } from '../../components/common';
import TimingForm from '../timetable/TimingForm';
import { weekdays } from '../timetable/timetable-utils';
import { profileGroups, adminFields, facilityOptions } from './profile-fields';

export default function SchoolProfile() {
  const a = useAuth(),
    { schoolId } = useParams(),
    [editing, setEditing] = useState(false),
    [timing, setTiming] = useState(false),
    base = schoolId ? `/platform/schools/${schoolId}/profile` : '/school-profile',
    q = useQuery({
      queryKey: [a.school, 'school-profile', a.me?.id, a.me?.school?.role, schoolId || 'own'],
      queryFn: () => api<Profile>(base),
      enabled: schoolId ? a.me?.platform_role === 'SUPER_ADMIN' : !!a.me?.school,
    });
  useEffect(() => {
    setEditing(false);
    setTiming(false);
  }, [a.school, schoolId, a.me?.id, a.me?.school?.role]);
  if (schoolId && a.me?.platform_role !== 'SUPER_ADMIN')
    return <Empty title="Access unavailable" description="Super Admin access is required." />;
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (!q.data)
    return (
      <Empty
        title="Select a school"
        description="Choose your school workspace to view its information."
      />
    );
  const p = q.data,
    logo = p.assets.find((i) => i.kind === 'LOGO'),
    images = p.assets.filter((i) => i.kind === 'IMAGE');
  return (
    <>
      <PageHeading
        title={p.can_delegate ? 'School profile' : 'School information'}
        description="One school. Every detail, connected."
        actions={
          <>
            {schoolId && (
              <Button asChild variant="outline">
                <Link to="/platform/schools">
                  <ArrowLeft size={16} />
                  Schools
                </Link>
              </Button>
            )}
            {p.can_edit && !editing && (
              <Button variant="lime" onClick={() => setEditing(true)}>
                <Pencil size={16} />
                Edit school profile
              </Button>
            )}
          </>
        }
      />
      <div className="mb-7 overflow-hidden rounded-3xl border border-line bg-white">
        <div className="h-3 bg-lime-300" />
        <div className="flex flex-wrap items-center gap-5 p-6 sm:p-8">
          {logo ? (
            <SchoolImage
              key={logo.id}
              asset={logo}
              base={base}
              className="h-24 w-24 rounded-2xl border border-line object-contain p-2"
            />
          ) : (
            <div className="grid h-24 w-24 place-items-center rounded-2xl bg-lime-100">
              <Building2 size={38} />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="mb-2 text-xs tracking-[.18em] text-stone-500">{p.school_code}</p>
            <h2 className="break-words text-2xl font-semibold sm:text-3xl">{p.name}</h2>
            <p className="mt-2 break-words text-stone-600">
              {p.details.tagline || p.details.motto}
            </p>
            <p className="mt-2 text-sm text-stone-500">
              {[p.details.board, p.details.city, p.details.country].filter(Boolean).join(' · ')}
            </p>
          </div>
          <span className="rounded-full bg-stone-50 px-3 py-2 text-xs">
            {p.can_edit ? 'Profile management' : 'Read-only school information'}
          </span>
        </div>
      </div>
      {p.completion && (
        <section
          aria-label="School profile completion"
          className="mb-7 rounded-2xl border border-lime-200 bg-lime-50 p-5 sm:p-6"
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Profile completion</h2>
            <strong>{p.completion.percent}% complete</strong>
          </div>
          <progress
            aria-label="School profile completion"
            value={p.completion.percent}
            max={100}
            className="h-2 w-full accent-lime-600"
          />
          <p className="mt-3 text-sm text-stone-600">
            {p.completion.complete} of {p.completion.total} required details completed. Save your
            progress at any time.
          </p>
          {!!p.completion.missing.length && (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-medium">
                View {p.completion.missing.length} missing required details
              </summary>
              <ul className="mt-3 grid list-disc gap-2 pl-5 text-sm sm:grid-cols-2">
                {p.completion.missing.map((m) => (
                  <li key={m.key}>
                    {m.label} <span className="text-stone-500">· {m.section}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
      {editing && p.can_edit ? (
        <ProfileForm
          key={`${p.school_id}:${p.version}`}
          profile={p}
          base={base}
          saved={async () => {
            setEditing(false);
            await q.refetch();
            await a.refetch();
          }}
          cancel={() => setEditing(false)}
        />
      ) : (
        <div className="space-y-6">
          <section
            className="rounded-2xl border border-line bg-white p-5 sm:p-7"
            aria-label="School contacts"
          >
            <h2 className="mb-5 text-xl font-semibold">Stay connected</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <Contact icon={<Phone size={18} />} label="School office" value={p.details.phone} />
              <Contact icon={<Mail size={18} />} label="School email" value={p.details.email} />
              <Contact
                icon={<Globe size={18} />}
                label="Website"
                value={p.details.website}
                website
              />
            </div>
          </section>
          {profileGroups.map((g) => (
            <section
              key={g.id}
              id={g.id}
              className="rounded-2xl border border-line bg-white p-5 sm:p-7"
            >
              <h2 className="mb-5 text-xl font-semibold">{g.title}</h2>
              <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
                {g.fields.map((f) => (
                  <div key={f.key} className={f.type === 'textarea' ? 'sm:col-span-2' : ''}>
                    <dt className="mb-1 text-xs font-medium uppercase tracking-wide text-stone-500">
                      {f.label}
                    </dt>
                    <dd className="whitespace-pre-wrap break-words text-sm leading-7">
                      {p.details[f.key] || <span className="text-stone-400">Not provided</span>}
                    </dd>
                  </div>
                ))}
              </dl>
              {g.id === 'facilities' && (
                <div className="mt-5 flex flex-wrap gap-2">
                  {p.details.facilities.length ? (
                    p.details.facilities.map((f) => (
                      <span key={f} className="rounded-full bg-lime-50 px-3 py-2 text-sm">
                        {f}
                      </span>
                    ))
                  ) : (
                    <p className="text-sm text-stone-400">Facilities have not been added yet.</p>
                  )}
                </div>
              )}
            </section>
          ))}
          {p.administration && (
            <section className="rounded-2xl border border-stone-200 bg-stone-50 p-5 sm:p-7">
              <h2 className="mb-2 flex items-center gap-2 text-xl font-semibold">
                <ShieldCheck size={20} />
                Administrative information
              </h2>
              <p className="mb-5 text-sm text-stone-600">
                Visible to Super Admin, School Admin and Principal.
              </p>
              <dl className="grid gap-5 sm:grid-cols-2">
                {adminFields.map((f) => (
                  <div key={f.key} className={f.type === 'textarea' ? 'sm:col-span-2' : ''}>
                    <dt className="mb-1 text-xs uppercase text-stone-500">{f.label}</dt>
                    <dd className="whitespace-pre-wrap break-words text-sm leading-7">
                      {p.administration![f.key] || 'Not provided'}
                    </dd>
                  </div>
                ))}
              </dl>
              {p.principal_edit_authorized && (
                <p className="mt-5 text-sm">
                  Principal profile editing has been authorized by an administrator.
                </p>
              )}
            </section>
          )}
        </div>
      )}
      <section
        aria-label="School timings"
        className="mt-6 rounded-2xl border border-line bg-white p-5 sm:p-7"
      >
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-xl font-semibold">
            <Clock size={20} />
            School timings
          </h2>
          {p.can_manage_timings && !editing && (
            <Button variant="outline" onClick={() => setTiming(true)}>
              Manage school timings
            </Button>
          )}
        </div>
        <p className="mb-4 text-sm text-stone-500">Timezone: {p.timezone}</p>
        {!p.timings.configured ? (
          <p className="text-sm text-stone-500">School timings have not been configured yet.</p>
        ) : (
          <>
            <p className="mb-4 text-sm">
              {p.timings.settings.days.map((d) => weekdays[d - 1]).join(', ')}
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                ...p.timings.settings.periods.map((v) => ({ ...v, kind: 'Lecture' })),
                ...p.timings.settings.breaks.map((v) => ({ ...v, kind: 'Break' })),
              ]
                .sort((x, y) => x.start_time.localeCompare(y.start_time))
                .map((v) => (
                  <div
                    key={`${v.kind}:${v.start_time}`}
                    className={`rounded-xl p-4 ${v.kind === 'Break' ? 'bg-lime-50' : 'bg-stone-50'}`}
                  >
                    <p className="text-sm font-medium">{v.label}</p>
                    <p className="mt-1 text-sm text-stone-500">
                      {v.start_time} – {v.end_time}
                    </p>
                  </div>
                ))}
            </div>
          </>
        )}
      </section>
      {timing && (
        <TimingForm
          key={`${p.school_id}:${p.timings.version}`}
          initial={p.timings}
          endpoint={base + '/timings'}
          onSaved={() => q.refetch()}
          close={() => setTiming(false)}
        />
      )}
      {!editing && (
        <section className="mt-6 rounded-2xl border border-line bg-white p-5 sm:p-7">
          <h2 className="mb-5 text-xl font-semibold">School images & policy documents</h2>
          {!!images.length && (
            <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {images.map((i) => (
                <figure key={i.id}>
                  <SchoolImage
                    asset={i}
                    base={base}
                    className="aspect-video w-full rounded-xl object-cover"
                  />
                  <figcaption className="mt-2 text-sm text-stone-500">{i.title}</figcaption>
                </figure>
              ))}
            </div>
          )}
          <ProfileFiles
            key={`${p.school_id}:${a.me?.id}`}
            assets={p.assets}
            base={base}
            canEdit={p.can_edit}
            refresh={() => q.refetch()}
          />
        </section>
      )}
      <section className="mt-6 rounded-2xl border border-line bg-white p-5 sm:p-7">
        <h2 className="mb-5 text-xl font-semibold">School announcements</h2>
        {p.announcements.length ? (
          p.announcements.map((n) => (
            <article key={n.id} className="border-t border-line py-4 first:border-0">
              <h3 className="font-semibold">{n.title}</h3>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-7 text-stone-600">
                {n.body}
              </p>
              <p className="mt-2 text-xs text-stone-400">
                {new Date(n.published_at).toLocaleDateString('en-IN', { timeZone: p.timezone })}
              </p>
            </article>
          ))
        ) : (
          <p className="text-sm text-stone-500">
            {schoolId
              ? 'Announcements are managed in the school workspace.'
              : 'No applicable school announcements have been published yet.'}
          </p>
        )}
      </section>
    </>
  );
}
function Contact({
  icon,
  label,
  value,
  website = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  website?: boolean;
}) {
  return (
    <div className="rounded-xl bg-stone-50 p-4">
      <p className="mb-3 flex items-center gap-2 text-sm text-stone-500">
        {icon}
        {label}
      </p>
      {website && value ? (
        <a
          className="break-all text-sm underline"
          href={value}
          target="_blank"
          rel="noopener noreferrer"
        >
          {value}
        </a>
      ) : (
        <p className="break-words text-sm">{value || 'Not provided'}</p>
      )}
    </div>
  );
}
function SchoolImage({
  asset,
  base,
  className,
}: {
  asset: SchoolProfileAsset;
  base: string;
  className: string;
}) {
  const a = useAuth(),
    [src, setSrc] = useState(''),
    q = useQuery({
      queryKey: [a.school, 'school-profile-image', a.me?.id, base, asset.id],
      queryFn: () => api<Blob>(`${base}/assets/${asset.id}`, {}, true, 'blob'),
      gcTime: 0,
    });
  useEffect(() => {
    if (!q.data) return;
    const url = URL.createObjectURL(q.data);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [q.data]);
  return src ? (
    <img src={src} alt={asset.title} className={className} />
  ) : (
    <div
      className={`${className} grid place-items-center bg-stone-50`}
      role="img"
      aria-label={q.error ? 'School image unavailable' : 'Loading school image'}
    >
      <Building2 className="text-stone-300" />
    </div>
  );
}
function ProfileForm({
  profile: p,
  base,
  saved,
  cancel,
}: {
  profile: Profile;
  base: string;
  saved: () => Promise<void>;
  cancel: () => void;
}) {
  const a = useAuth(),
    [details, setDetails] = useState(() => structuredClone(p.details)),
    [administration, setAdmin] = useState(() => structuredClone(p.administration!)),
    [name, setName] = useState(p.name),
    [timezone, setTimezone] = useState(p.timezone),
    [locale, setLocale] = useState(p.locale),
    [delegate, setDelegate] = useState(p.principal_edit_authorized || false),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState(''),
    [extra, setExtra] = useState('');
  useUnsavedChanges(dirty);
  const save = useMutation({
    mutationFn: async () => {
      const parsed = schoolProfileUpdateSchema.safeParse({
        expected_version: p.version,
        name,
        timezone,
        locale,
        details,
        administration,
        ...(p.can_delegate ? { principal_edit_authorized: delegate } : {}),
      });
      if (!parsed.success)
        throw new Error(
          parsed.error.issues.map((i) => `${i.path.join(' ')}: ${i.message}`).join(' · '),
        );
      return api(base, { method: 'PUT', body: JSON.stringify(parsed.data) }, true, 'json', {
        userId: a.me!.id,
        schoolId: a.requestSchool,
      });
    },
    onSuccess: async () => {
      setDirty(false);
      await saved();
    },
    onError: (e: Error) => setError(e.message),
  });
  const update = (key: keyof SchoolProfileDetails, value: string | string[]) => {
    setDetails((d) => ({ ...d, [key]: value }));
    setDirty(true);
  };
  const inputClass = 'input mt-2 w-full';
  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        setError('');
        save.mutate();
      }}
    >
      <p className="rounded-xl bg-stone-50 p-4 text-sm leading-6 text-stone-600">
        You can save an incomplete profile. Missing required details are shown in the completion
        checklist. Use official school contacts in sections visible to families.
      </p>
      <fieldset disabled={save.isPending} className="min-w-0 space-y-6">
        <section className="rounded-2xl border border-line bg-white p-5 sm:p-7">
          <h2 className="mb-5 text-xl font-semibold">School account details</h2>
          <div className="grid gap-5 sm:grid-cols-2">
            <label className="text-sm">
              School name
              <input
                required
                maxLength={200}
                value={name}
                className={inputClass}
                onChange={(e) => {
                  setName(e.target.value);
                  setDirty(true);
                }}
              />
            </label>
            <label className="text-sm">
              School code
              <input value={p.school_code} className={inputClass} readOnly />
            </label>
            <label className="text-sm">
              School timezone
              <input
                value={timezone}
                className={inputClass}
                maxLength={100}
                onChange={(e) => {
                  setTimezone(e.target.value);
                  setDirty(true);
                }}
              />
            </label>
            <label className="text-sm">
              School language
              <select
                className={inputClass}
                value={locale}
                onChange={(e) => {
                  setLocale(e.target.value as typeof locale);
                  setDirty(true);
                }}
              >
                <option value="en-IN">English</option>
                <option value="hi-IN">Hindi</option>
              </select>
            </label>
          </div>
        </section>
        {profileGroups.map((g) => (
          <section key={g.id} className="rounded-2xl border border-line bg-white p-5 sm:p-7">
            <h2 className="text-xl font-semibold">{g.title}</h2>
            <p className="mb-5 mt-2 text-sm text-stone-500">{g.description}</p>
            <div className="grid gap-5 sm:grid-cols-2">
              {g.fields.map((f) => (
                <label
                  key={f.key}
                  className={`text-sm ${f.type === 'textarea' ? 'sm:col-span-2' : ''}`}
                >
                  {f.label}
                  {p.completion?.missing.some((m) => m.key === f.key) && (
                    <span className="ml-2 text-xs text-amber-700">Required for completion</span>
                  )}
                  {f.type === 'textarea' ? (
                    <textarea
                      rows={4}
                      maxLength={f.max || 200}
                      className={inputClass}
                      value={details[f.key]}
                      onChange={(e) => update(f.key, e.target.value)}
                    />
                  ) : (
                    <input
                      type={f.type || 'text'}
                      maxLength={f.max || 200}
                      className={inputClass}
                      value={details[f.key]}
                      onChange={(e) => update(f.key, e.target.value)}
                    />
                  )}
                </label>
              ))}
            </div>
            {g.id === 'facilities' && (
              <fieldset className="mt-6">
                <legend className="mb-4 text-sm font-semibold">Available facilities</legend>
                <div className="grid gap-3 sm:grid-cols-3">
                  {[...new Set([...facilityOptions, ...details.facilities])].map((v) => (
                    <label key={v} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={details.facilities.includes(v)}
                        onChange={(e) =>
                          update(
                            'facilities',
                            e.target.checked
                              ? [...details.facilities, v]
                              : details.facilities.filter((i) => i !== v),
                          )
                        }
                      />
                      {v}
                    </label>
                  ))}
                </div>
                <div className="mt-4 flex flex-wrap items-end gap-2">
                  <label className="min-w-0 flex-1 text-sm">
                    Other facility
                    <input
                      className={inputClass}
                      value={extra}
                      maxLength={100}
                      onChange={(e) => setExtra(e.target.value)}
                    />
                  </label>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!extra.trim() || details.facilities.length >= 40}
                    onClick={() => {
                      update('facilities', [...new Set([...details.facilities, extra.trim()])]);
                      setExtra('');
                    }}
                  >
                    Add facility
                  </Button>
                </div>
              </fieldset>
            )}
          </section>
        ))}
        {administration && (
          <section className="rounded-2xl border border-stone-200 bg-stone-50 p-5 sm:p-7">
            <h2 className="text-xl font-semibold">Administrative information</h2>
            <p className="mb-5 mt-2 text-sm text-stone-500">
              Restricted to Super Admin, School Admin and Principal.
            </p>
            <div className="grid gap-5 sm:grid-cols-2">
              {adminFields.map((f) => (
                <label
                  key={f.key}
                  className={`text-sm ${f.type === 'textarea' ? 'sm:col-span-2' : ''}`}
                >
                  {f.label}
                  {f.type === 'textarea' ? (
                    <textarea
                      className={inputClass}
                      rows={4}
                      maxLength={f.max || 200}
                      value={administration[f.key]}
                      onChange={(e) => {
                        setAdmin((v) => ({ ...v, [f.key]: e.target.value }));
                        setDirty(true);
                      }}
                    />
                  ) : (
                    <input
                      className={inputClass}
                      type={f.type || 'text'}
                      maxLength={f.max || 200}
                      value={administration[f.key]}
                      onChange={(e) => {
                        setAdmin((v) => ({ ...v, [f.key]: e.target.value }));
                        setDirty(true);
                      }}
                    />
                  )}
                </label>
              ))}
            </div>
            {p.can_delegate && (
              <label className="mt-6 flex items-start gap-3 rounded-xl border border-line bg-white p-4 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={delegate}
                  onChange={(e) => {
                    setDelegate(e.target.checked);
                    setDirty(true);
                  }}
                />
                <span>
                  Authorize Principal to edit the school profile
                  <span className="mt-1 block text-xs text-stone-500">
                    This grants profile editing only. Timetable administration and other permissions
                    remain as configured.
                  </span>
                </span>
              </label>
            )}
          </section>
        )}
      </fieldset>
      <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-end gap-3 rounded-2xl border border-line bg-white/95 p-4 shadow-lg backdrop-blur">
        {error && (
          <p role="alert" className="field-error basis-full">
            {error}
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={save.isPending}
          onClick={() => {
            if (!dirty || window.confirm('Discard unsaved school profile changes?')) {
              setDirty(false);
              cancel();
            }
          }}
        >
          Cancel
        </Button>
        <Button variant="lime" disabled={save.isPending}>
          <Save size={16} />
          {save.isPending ? 'Saving…' : 'Save profile'}
        </Button>
      </div>
    </form>
  );
}
function ProfileFiles({
  assets,
  base,
  canEdit,
  refresh,
}: {
  assets: SchoolProfileAsset[];
  base: string;
  canEdit: boolean;
  refresh: () => Promise<unknown>;
}) {
  const [kind, setKind] = useState<'LOGO' | 'IMAGE' | 'POLICY'>('LOGO'),
    [title, setTitle] = useState(''),
    [file, setFile] = useState<File>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [fileKey, setFileKey] = useState(0),
    qc = useQueryClient(),
    a = useAuth();
  const download = async (i: SchoolProfileAsset) => {
    setError('');
    try {
      const blob = await api<Blob>(`${base}/assets/${i.id}`, {}, true, 'blob'),
        url = URL.createObjectURL(blob),
        anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${i.title.replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 100) || 'School policy'}.pdf`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="space-y-5">
      {!assets.length && !canEdit && (
        <p className="text-sm text-stone-500">
          School images and policy documents have not been added yet.
        </p>
      )}
      <ul className="divide-y divide-line">
        {assets
          .filter((i) => canEdit || i.kind === 'POLICY')
          .map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-3 py-3">
              <FileText size={18} className="shrink-0 text-stone-400" />
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium">{i.title}</p>
                <p className="text-xs text-stone-400">
                  {i.kind} · {(i.size / 1024).toFixed(0)} KB
                </p>
              </div>
              {i.kind === 'POLICY' && (
                <Button type="button" variant="outline" size="sm" onClick={() => download(i)}>
                  <Download size={14} />
                  Download
                </Button>
              )}
              {canEdit && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={`Remove ${i.title}`}
                  onClick={async () => {
                    if (!window.confirm(`Remove ${i.title} from the school profile?`)) return;
                    setBusy(true);
                    setError('');
                    try {
                      await api(`${base}/assets/${i.id}`, { method: 'DELETE' }, true, 'json', {
                        userId: a.me!.id,
                        schoolId: a.requestSchool,
                      });
                      await refresh();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Trash2 size={14} />
                  Remove
                </Button>
              )}
            </li>
          ))}
      </ul>
      {canEdit && (
        <form
          className="grid gap-4 rounded-xl bg-stone-50 p-4 sm:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!file || busy) return;
            setBusy(true);
            setError('');
            try {
              const data = new FormData();
              data.set('kind', kind);
              data.set('title', title);
              data.set('file', file);
              await api(base + '/assets', { method: 'POST', body: data }, true, 'json', {
                userId: a.me!.id,
                schoolId: a.requestSchool,
              });
              setFile(undefined);
              setTitle('');
              setFileKey((v) => v + 1);
              await refresh();
              await qc.invalidateQueries({ queryKey: [a.school, 'school-profile-image'] });
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="text-sm">
            File purpose
            <select
              className="input mt-2"
              value={kind}
              disabled={busy}
              onChange={(e) => {
                setKind(e.target.value as typeof kind);
                setFile(undefined);
                setFileKey((v) => v + 1);
              }}
            >
              <option value="LOGO">School logo</option>
              <option value="IMAGE">School image</option>
              <option value="POLICY">School policy PDF</option>
            </select>
          </label>
          <label className="text-sm">
            File title / image description
            <input
              className="input mt-2"
              value={title}
              required
              maxLength={150}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="min-w-0 text-sm">
            Choose file
            <input
              key={fileKey}
              className="mt-2 block w-full min-w-0 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-white file:px-3 file:py-2"
              type="file"
              accept={kind === 'POLICY' ? 'application/pdf' : 'image/png,image/jpeg,image/webp'}
              required
              disabled={busy}
              onChange={(e) => setFile(e.target.files?.[0])}
            />
          </label>
          <div className="flex items-end">
            <Button variant="outline" disabled={busy || !file}>
              <ImagePlus size={16} />
              {busy ? 'Uploading…' : 'Upload file'}
            </Button>
          </div>
          <p className="text-xs leading-6 text-stone-500 sm:col-span-2">
            PNG, JPEG or WebP images up to 5 MB. Policy PDFs up to 10 MB. Up to 12 images and 20
            policy documents. Uploading a logo replaces the current logo.
          </p>
        </form>
      )}
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}
