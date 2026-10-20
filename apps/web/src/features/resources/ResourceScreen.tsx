import { useSearchParams, Link } from 'react-router-dom';
import { schoolPath } from '../../lib/portals';
import RecordImportDialog, { type ImportResource } from './RecordImportDialog';
import { ActionDialog } from '../../components/ActionDialog';
import BulkMarksDialog from './BulkMarksDialog';
import RecordSelect from '../../components/RecordSelect';
import ResourceDetails from './ResourceDetails';
import StudentProfileDialog from './StudentProfileDialog';
import AttendanceRuleBuilder from '../operations/AttendanceRuleBuilder';
import FeePaymentDialog from './FeePaymentDialog';
import { IssueCardDialog, BlockCardDialog } from './CardActionDialogs';
import { useEffect, useMemo, useState } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { resourceSchemas, type Resource, type Page } from '@vidyalayaa/contracts';
import {
  Plus,
  Search,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  LockKeyhole,
} from 'lucide-react';
import { api, configured, useAuth, supabase } from '../../lib/auth';
import { label, display, toDateTimeLocal, fromDateTimeLocal } from '../../lib/utils';
import { readDraft, saveDraft, deleteDraft } from '../../lib/drafts';
import { useUnsavedChanges } from '../../lib/use-unsaved-changes';
import { fields, resourceInfo, sampleRule, type Field } from './metadata';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { PageHeading, Panel, Empty, Loading, ErrorState, DataTable } from '../../components/common';
export function ResourceScreen({ resource }: { resource: Resource }) {
  const [params] = useSearchParams();
  const a = useAuth(),
    qc = useQueryClient(),
    [bulk, setBulk] = useState(false),
    [importing, setImporting] = useState(false),
    [retiring, setRetiring] = useState<Record<string, unknown> | null>(null),
    [dirty, setDirty] = useState(false),
    [view, setView] = useState<string | null>(null),
    [search, setSearch] = useState(params.get('search') || ''),
    [page, setPage] = useState(1),
    [editing, setEditing] = useState<Record<string, unknown> | null | undefined>(undefined),
    [payingFee, setPayingFee] = useState<Record<string, unknown> | null>(null),
    [issuingCard, setIssuingCard] = useState(false),
    [blockingCard, setBlockingCard] = useState<{ id: string; card_uid: string; student_id: string } | null>(null),
    [actionNotice, setActionNotice] = useState(''),
    info = resourceInfo[resource],
    canWrite = !!info.write && !!a.me?.school?.permissions.includes(info.write),
    locked = !!info.feature && !a.me?.features[info.feature];
  useEffect(() => {
    setPage(1);
    setSearch(params.get('search') || '');
    setEditing(undefined);
    setView(null);
    setDirty(false);
  }, [resource, params, a.school]);
  const closeForm = () => {
    if (
      !dirty ||
      window.confirm('Close this form with unsaved changes? The draft remains only in this tab.')
    ) {
      setEditing(undefined);
      setDirty(false);
    }
  };
  const query = useQuery({
    queryKey: [a.school, resource, search, page],
    queryFn: () =>
      api<Page>(`/resources/${resource}?page=${page}&search=${encodeURIComponent(search)}`),
    enabled: configured && !!a.me?.school && !locked,
  });
  return (
    <>
      <PageHeading
        title={info.title}
        description={info.description}
        actions={
          <>
            {[
              'students',
              'parents',
              'teachers',
              'student_parents',
              'teacher_class_assignments',
            ].includes(resource) &&
              canWrite &&
              a.me?.school?.permissions.includes('users.manage') && (
                <Button variant="outline" onClick={() => setImporting(true)}>
                  Import CSV
                </Button>
              )}
            {resource === 'marks' && canWrite && (
              <Button variant="outline" onClick={() => setBulk(true)}>
                Import CSV
              </Button>
            )}
            {resource === 'nfc_cards' && canWrite && (
              <Button variant="lime" onClick={() => setIssuingCard(true)}>
                <Plus size={17} />
                Issue Card
              </Button>
            )}
            {(!configured || canWrite) && resource !== 'nfc_cards' && (
              <Button
                variant="lime"
                onClick={() => setEditing(null)}
                disabled={!canWrite || locked}
              >
                <Plus size={17} />
                Add {resource === 'students' ? 'student' : 'record'}
              </Button>
            )}
          </>
        }
      />
      {['students', 'parents', 'student_parents'].includes(resource) && (
        <div className="tabs">
          <Link
            className={resource === 'students' ? 'tab-active' : ''}
            to={schoolPath('/r/students', a.me?.school?.role)}
          >
            Students
          </Link>
          <Link
            className={resource === 'parents' ? 'tab-active' : ''}
            to={schoolPath('/r/parents', a.me?.school?.role)}
          >
            Parents & Guardians
          </Link>
          <Link
            className={resource === 'student_parents' ? 'tab-active' : ''}
            to={schoolPath('/r/student_parents', a.me?.school?.role)}
          >
            Family Connections
          </Link>
        </div>
      )}
      {locked && configured ? (
        <div className="notice">
          <LockKeyhole size={20} />
          This module is available with a Professional or Enterprise plan.
        </div>
      ) : (
        <Panel
          title="All records"
          subtitle={`${query.data?.total ?? 0} records in your school`}
          action={<span className="text-xs text-stone-500">School records</span>}
        >
          <div className="table-toolbar">
            <div className="search-input">
              <Search size={16} />
              <input
                aria-label={`Search ${info.title}`}
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder={`Search ${info.title.toLowerCase()}…`}
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSearch('');
                setPage(1);
              }}
            >
              <SlidersHorizontal size={14} />
              Reset filters
            </Button>
          </div>
          {query.isLoading ? (
            <Loading />
          ) : query.error ? (
            <ErrorState error={query.error} retry={() => query.refetch()} />
          ) : query.data?.data.length ? (
            <DataTable
              rows={query.data.data}
              columns={info.columns}
              onView={(row) => setView(String(row.id))}
              actions={
                resource === 'fee_records'
                  ? (row) => (
                      <div className="flex gap-1.5">
                        {canWrite && !['PAID', 'WAIVED'].includes(String(row.status)) && (
                          <Button size="sm" variant="lime" onClick={() => setPayingFee(row)}>
                            Pay
                          </Button>
                        )}
                        {canWrite && !['PAID', 'WAIVED'].includes(String(row.status)) && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={async () => {
                              try {
                                const res = await api<{ queued: boolean }>(`/fees/${row.id}/remind`, { method: 'POST' });
                                setActionNotice(res.queued ? 'Fee reminder queued.' : 'A reminder was already queued today.');
                              } catch (e) {
                                setActionNotice((e as Error).message);
                              }
                            }}
                          >
                            Remind
                          </Button>
                        )}
                      </div>
                    )
                  : resource === 'nfc_cards'
                    ? (row) => (
                        canWrite && row.status === 'ACTIVE' ? (
                          <Button size="sm" variant="outline" onClick={() => setBlockingCard(row as { id: string; card_uid: string; student_id: string })}>
                            Deactivate
                          </Button>
                        ) : undefined
                      )
                    : resource === 'students'
                      ? (row) => (
                          <Button size="sm" variant="outline" onClick={() => setView(String(row.id))}>
                            Profile
                          </Button>
                        )
                      : canWrite &&
                        [
                          'academic_sessions',
                          'classes',
                          'subjects',
                          'exams',
                          'assignments',
                          'timetable_entries',
                          'school_holidays',
                          'announcements',
                          'teacher_class_assignments',
                        ].includes(resource)
                        ? (row) => (
                            <Button size="sm" variant="outline" onClick={() => setRetiring(row)}>
                              Archive
                            </Button>
                          )
                        : undefined
              }
              onEdit={canWrite && !['attendance_rule_versions', 'nfc_cards'].includes(resource) ? setEditing : undefined}
            />
          ) : (
            <Empty
              title={`Your ${info.title.toLowerCase()} belong here`}
              description={
                configured
                  ? 'Add your first record to get started.'
                  : 'Connect your school’s Supabase project and API to start managing real records.'
              }
              action={
                canWrite && (
                  <Button size="sm" variant="outline" onClick={() => setEditing(null)}>
                    <Plus size={15} />
                    Add first record
                  </Button>
                )
              }
            />
          )}
          <div className="pagination">
            <span>
              Page {page} · {query.data?.total ?? 0} records
            </span>
            <div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Previous page"
                disabled={page === 1}
                onClick={() => setPage((p) => p - 1)}
              >
                <ChevronLeft size={16} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Next page"
                disabled={!query.data || page * query.data.page_size >= query.data.total}
                onClick={() => setPage((p) => p + 1)}
              >
                <ChevronRight size={16} />
              </Button>
            </div>
          </div>
        </Panel>
      )}
      {importing && (
        <RecordImportDialog
          resource={resource as ImportResource}
          close={() => setImporting(false)}
        />
      )}
      {retiring && (
        <ActionDialog
          open
          close={() => setRetiring(null)}
          title="Archive this record"
          endpoint={`/resources/${resource}/${retiring.id}/retire`}
          fields={[{ key: 'reason', type: 'textarea' }]}
        />
      )}
      {bulk && <BulkMarksDialog open={bulk} close={() => setBulk(false)} />}
      {actionNotice && (
        <div className="notice mb-4" role="status">
          {actionNotice}
        </div>
      )}
      {payingFee && <FeePaymentDialog fee={payingFee as any} close={() => setPayingFee(null)} />}
      {issuingCard && <IssueCardDialog open={issuingCard} close={() => setIssuingCard(false)} />}
      {blockingCard && <BlockCardDialog card={blockingCard} close={() => setBlockingCard(null)} />}
      {view &&
        (resource === 'students' ? (
          <StudentProfileDialog studentId={view} close={() => setView(null)} />
        ) : (
          <ResourceDetails resource={resource} id={view} close={() => setView(null)} />
        ))}
      <Dialog
        open={editing !== undefined}
        onOpenChange={(open) => {
          if (!open) closeForm();
        }}
        title={`${editing ? 'Edit' : 'Add'} ${info.title.toLowerCase()}`}
      >
        <ResourceForm
          key={`${resource}-${String(editing?.id || 'new')}`}
          resource={resource}
          initial={editing || undefined}
          onDirtyChange={setDirty}
          cancel={closeForm}
          done={() => {
            setDirty(false);
            setEditing(undefined);
            qc.invalidateQueries({ queryKey: [a.school] });
          }}
        />
      </Dialog>
    </>
  );
}
function RefField({
  field,
  value,
  onChange,
}: {
  field: Field;
  value: string;
  onChange: (v: string) => void;
}) {
  const { school, me } = useAuth(),
    [search, setSearch] = useState('');
  const own = field.ref === 'parents' && me?.school?.role === 'parent';
  const q = useQuery({
    queryKey: [school, 'ref', field.ref, search, own],
    queryFn: () =>
      api<Page>(
        own
          ? '/profile/parent'
          : `/resources/${field.ref}?page_size=100&search=${encodeURIComponent(search)}`,
      ),
    enabled: configured,
  });
  return (
    <div>
      <input
        className="input mb-2 h-9 text-xs"
        aria-label={`Find ${label(field.key)}`}
        placeholder="Find by name or code…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <select
        className="input"
        id={field.key}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{field.optional ? 'None' : 'Select a record'}</option>
        {q.data?.data.map((row) => (
          <option key={String(row.id)} value={String(row.id)}>
            {String(
              row.full_name ||
                row.name ||
                row.title ||
                `${row.first_name || row.grade || ''} ${row.last_name || row.section || ''}`,
            )}
            {row.student_code ? ` · ${row.student_code}` : ''}
          </option>
        ))}
        {value && !q.data?.data.some((x) => x.id === value) && (
          <option value={value}>{value}</option>
        )}
      </select>
      {q.error && <p className="field-error">{q.error.message}</p>}
    </div>
  );
}
export function ResourceForm({
  resource,
  initial,
  done,
  cancel,
  onDirtyChange,
}: {
  resource: Resource;
  initial?: Record<string, unknown>;
  done: () => void;
  cancel?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const a = useAuth(),
    [error, setError] = useState(''),
    [statusMessage, setStatusMessage] = useState(''),
    [uploading, setUploading] = useState(false),
    draftKey = `vidyalayaa.draft.${a.me?.id}.${a.school}.${resource}.${initial?.id || 'new'}`;
  const [restored, setRestored] = useState(() => Object.keys(readDraft(draftKey)).length > 0);
  const defaults = useMemo(() => {
    const saved = readDraft(draftKey);
    return Object.fromEntries(
      fields[resource].map((f) => {
        let value =
          saved[f.key] ??
          initial?.[f.key] ??
          (f.type === 'checkbox' ? false : (f.options?.[0] ?? (f.optional ? null : '')));
        if (f.key === 'rules' && typeof value === 'object') value = JSON.stringify(value, null, 2);
        if (f.type === 'datetime-local' && value && !saved[f.key])
          value = toDateTimeLocal(value, a.me?.school?.timezone);
        return [f.key, value];
      }),
    );
  }, [resource, initial, draftKey, a.me?.school?.timezone]);
  const resolver: Resolver<Record<string, unknown>> = async (values, context, options) => {
    const transformed = { ...values };
    for (const f of fields[resource].filter((f) => f.type === 'datetime-local')) {
      if (transformed[f.key])
        try {
          transformed[f.key] = fromDateTimeLocal(
            String(transformed[f.key]),
            a.me?.school?.timezone,
          );
        } catch (e) {
          return {
            values: {},
            errors: { [f.key]: { type: 'validate', message: (e as Error).message } },
          };
        }
    }
    if (typeof transformed.rules === 'string') {
      try {
        transformed.rules = JSON.parse(transformed.rules);
      } catch {
        return {
          values: {},
          errors: {
            rules: { type: 'validate', message: 'Enter valid JSON for the rule configuration.' },
          },
        };
      }
    }
    return zodResolver(resourceSchemas[resource])(transformed, context, options) as ReturnType<
      Resolver<Record<string, unknown>>
    >;
  };
  const form = useForm<Record<string, unknown>>({ defaultValues: defaults, resolver });
  useUnsavedChanges(form.formState.isDirty || restored);
  useEffect(
    () => onDirtyChange?.(form.formState.isDirty || restored),
    [form.formState.isDirty, onDirtyChange, restored],
  );
  useEffect(() => {
    const s = form.watch((values) => saveDraft(draftKey, values));
    return () => s.unsubscribe();
  }, [form, draftKey]);
  const mutation = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      api(`/resources/${resource}${initial ? `/${initial.id}` : ''}`, {
        method: initial ? 'PATCH' : 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(values),
      }),
    onSuccess: () => {
      setRestored(false);
      form.reset(form.getValues());
      deleteDraft(draftKey);
      done();
    },
    onError: (e) => setError(e.message),
  });
  return (
    <form
      onSubmit={form.handleSubmit((v) => {
        setError('');
        mutation.mutate(v);
      })}
      className="form-grid"
      noValidate
    >
      {fields[resource].map((f) => (
        <div className={f.type === 'textarea' ? 'col-span-full' : ''} key={f.key}>
          <label className="field-label" htmlFor={f.key}>
            {label(f.key.replace(/_id$/, ''))}
            {f.optional && <span>optional</span>}
          </label>
          {f.accountRole ? (
            <RecordSelect
              name={f.key}
              id={f.key}
              endpoint={`/lookups/accounts?role=${f.accountRole}`}
              value={String(form.watch(f.key) || '')}
              onChange={(value) =>
                form.setValue(f.key, value || null, { shouldValidate: true, shouldDirty: true })
              }
              optional={f.optional}
              label={`${f.accountRole} account`}
            />
          ) : f.ref ? (
            <RefField
              field={f}
              value={String(form.watch(f.key) || '')}
              onChange={(v) =>
                form.setValue(f.key, v || null, { shouldValidate: true, shouldDirty: true })
              }
            />
          ) : f.type === 'checkbox' ? (
            <input
              id={f.key}
              className="size-5 accent-lime-600"
              type="checkbox"
              {...form.register(f.key)}
            />
          ) : f.type === 'select' ? (
            <select id={f.key} className="input" {...form.register(f.key)}>
              {f.options?.map((o) => (
                <option key={o} value={o}>
                  {label(o)}
                </option>
              ))}
            </select>
          ) : f.type === 'textarea' ? (
            f.key === 'rules' ? (
              <div className="col-span-full">
                <AttendanceRuleBuilder
                  value={String(form.watch('rules') || '')}
                  onChange={(v) =>
                    form.setValue('rules', v, { shouldDirty: true, shouldValidate: true })
                  }
                />
              </div>
            ) : (
              <textarea
                id={f.key}
                className="input min-h-28"
                rows={4}
                {...form.register(f.key, {
                  setValueAs: (v) => (v === '' && f.optional ? null : v),
                })}
              />
            )
          ) : (
            <input
              id={f.key}
              className="input"
              type={f.type || 'text'}
              step={f.type === 'number' ? '0.01' : undefined}
              {...form.register(f.key, {
                setValueAs: (v) =>
                  v === '' && f.optional ? null : f.type === 'number' ? Number(v) : v,
              })}
            />
          )}{' '}
          {resource === 'assignments' && f.key === 'storage_path' && (
            <div className="mt-3">
              <input
                aria-label="Upload private material"
                type="file"
                accept=".pdf,.png,.jpg,.jpeg"
                disabled={uploading}
                className="input"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setUploading(true);
                  try {
                    if (file.size > 10 * 1024 * 1024)
                      throw new Error('Choose a file smaller than 10 MB.');
                    const class_id = String(form.getValues('class_id') || '');
                    if (!class_id) throw new Error('Select a class before uploading.');
                    const ticket = await api<{ path: string; token: string }>('/materials/upload', {
                      method: 'POST',
                      body: JSON.stringify({
                        class_id,
                        filename: file.name.replace(/[^a-zA-Z0-9._-]/g, '_'),
                      }),
                    });
                    const uploaded = await supabase!.storage
                      .from('school-documents')
                      .uploadToSignedUrl(ticket.path, ticket.token, file);
                    if (uploaded.error) throw uploaded.error;
                    form.setValue('storage_path', ticket.path, { shouldDirty: true });
                  } catch (error) {
                    setError((error as Error).message);
                  } finally {
                    setUploading(false);
                  }
                }}
              />
              <p className="mt-2 text-xs text-stone-500">
                {uploading ? 'Uploading securely�' : 'Private PDF, PNG or JPEG. Up to 10 MB.'}
              </p>
            </div>
          )}{' '}
          {form.formState.errors[f.key] && (
            <p className="field-error" role="alert">
              {String(form.formState.errors[f.key]?.message || 'Check this value.')}
            </p>
          )}
        </div>
      ))}
      {resource === 'fee_records' && initial && (
        <div className="col-span-full">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                const r = await api<{ queued: boolean }>(`/fees/${initial.id}/remind`, {
                  method: 'POST',
                });
                setStatusMessage(
                  r.queued ? 'Fee reminder queued.' : 'A reminder has already been queued today.',
                );
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Send fee reminder
          </Button>
        </div>
      )}
      {statusMessage && (
        <p className="col-span-full text-xs text-green-800" role="status">
          {statusMessage}
        </p>
      )}
      {error && (
        <p className="field-error col-span-full" role="alert">
          {error}
        </p>
      )}
      <div className="col-span-full mt-3 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={cancel || done}>
          Cancel
        </Button>
        <Button type="submit" variant="lime" disabled={mutation.isPending || uploading}>
          {mutation.isPending ? 'Saving…' : 'Save record'}
        </Button>
      </div>
    </form>
  );
}
