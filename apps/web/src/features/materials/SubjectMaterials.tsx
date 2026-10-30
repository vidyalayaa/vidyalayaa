import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Page, SubjectMaterial } from '@vidyalayaa/contracts';
import { api, downloadReport, supabase, useAuth } from '../../lib/auth';
import { useUnsavedChanges } from '../../lib/use-unsaved-changes';
import { Dialog } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Empty, ErrorState, Loading } from '../../components/common';

export interface MaterialSubject {
  classId: string;
  subjectId: string;
  name: string;
  classLabel: string;
}
export default function SubjectMaterials({
  subject,
  close,
  basePath = '/materials',
}: {
  subject: MaterialSubject;
  close: () => void;
  basePath?: string;
}) {
  const a = useAuth(),
    [page, setPage] = useState(1),
    [edit, setEdit] = useState<SubjectMaterial | null | undefined>(),
    [busy, setBusy] = useState(false),
    [formPending, setFormPending] = useState(false),
    [formSaving, setFormSaving] = useState(false),
    [error, setError] = useState(''),
    [preview, setPreview] = useState<{ url: string; name: string; type: string }>();
  const canManage =
    ['school_admin', 'teacher'].includes(a.me?.school?.role || '') &&
    !!a.me?.school?.permissions.includes('assignments.write');
  const enabled = !!a.me?.features.assignments;
  const q = useQuery({
    queryKey: [
      a.school,
      a.me?.id,
      'subject-materials',
      basePath,
      subject.classId,
      subject.subjectId,
      page,
    ],
    queryFn: ({ signal }) =>
      api<Page<SubjectMaterial>>(
        `${basePath}?class_id=${subject.classId}&subject_id=${subject.subjectId}&page=${page}`,
        { signal },
      ),
    enabled,
    staleTime: 0,
  });
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );
  async function file(row: SubjectMaterial, open: boolean) {
    setBusy(true);
    setError('');
    try {
      const ticket = await api<{ url: string }>(`/materials/${row.id}/download`);
      if (!/^\/materials\/[0-9a-f-]+\/file\?/.test(ticket.url))
        throw new Error('Invalid material address.');
      if (!open) {
        await downloadReport(ticket.url, row.filename || 'study-material');
        return;
      }
      const blob = await api<Blob>(ticket.url, {}, true, 'blob');
      const ext = row.filename?.split('.').at(-1)?.toLowerCase();
      const type =
        ext === 'pdf'
          ? 'application/pdf'
          : ext === 'png'
            ? 'image/png'
            : ['jpg', 'jpeg'].includes(ext || '')
              ? 'image/jpeg'
              : undefined;
      if (!type) throw new Error('Preview is unavailable for this file. Please download it.');
      setPreview({
        url: URL.createObjectURL(new Blob([blob], { type })),
        name: row.filename || row.title,
        type,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !formSaving && (!formPending || window.confirm('Discard the unsaved material?')))
          close();
      }}
      title={`${subject.name} · Study materials`}
      description={subject.classLabel}
    >
      {edit !== undefined ? (
        <MaterialForm
          subject={subject}
          initial={edit}
          pending={setFormPending}
          saving={setFormSaving}
          close={() => setEdit(undefined)}
          done={async () => {
            setEdit(undefined);
            await q.refetch();
          }}
        />
      ) : (
        <>
          {canManage && enabled && (
            <Button className="mb-5" variant="lime" onClick={() => setEdit(null)}>
              Add study material
            </Button>
          )}
          {!enabled ? (
            <Empty
              title="Study materials unavailable"
              description="Your school plan does not include study materials."
            />
          ) : q.isLoading ? (
            <Loading />
          ) : q.error ? (
            <ErrorState error={q.error} retry={() => q.refetch()} />
          ) : !q.data?.data.length ? (
            <Empty
              title="No study materials yet"
              description="Materials shared for this subject will appear here."
            />
          ) : (
            <div className="space-y-4">
              {q.data.data.map((row) => (
                <article key={row.id} className="rounded-2xl border border-line p-4">
                  <h3 className="break-words font-semibold">{row.title}</h3>
                  {row.body && (
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm">{row.body}</p>
                  )}
                  {row.filename && (
                    <p className="mt-3 break-all text-xs text-stone-500">
                      {row.filename.replace(/^[0-9a-f-]{36}-/, '')}
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {row.has_attachment && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => file(row, true)}
                        >
                          Open material
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => file(row, false)}
                        >
                          Download material
                        </Button>
                      </>
                    )}
                    {canManage && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setEdit(row)}>
                          Edit material
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={async () => {
                            if (
                              !window.confirm(
                                'Archive this material? It will no longer appear to students and parents.',
                              )
                            )
                              return;
                            setBusy(true);
                            setError('');
                            try {
                              await api(`/resources/assignments/${row.id}/retire`, {
                                method: 'POST',
                                headers: { 'Idempotency-Key': crypto.randomUUID() },
                                body: JSON.stringify({
                                  reason: 'Archived from subject study materials',
                                }),
                              });
                              await q.refetch();
                            } catch (e) {
                              setError((e as Error).message);
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          Archive material
                        </Button>
                      </>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
          {error && (
            <p className="field-error mt-4" role="alert">
              {error}
            </p>
          )}
          {q.data && q.data.total > q.data.page_size && (
            <div className="mt-4 flex items-center gap-3">
              <Button variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)}>
                Previous
              </Button>
              <span className="text-sm">Page {page}</span>
              <Button
                variant="outline"
                disabled={page * q.data.page_size >= q.data.total}
                onClick={() => setPage(page + 1)}
              >
                Next
              </Button>
            </div>
          )}
          {preview && (
            <section className="mt-5" aria-label="Material preview">
              <div className="mb-3 flex justify-between gap-2">
                <h3 className="break-all text-sm font-semibold">
                  {preview.name.replace(/^[0-9a-f-]{36}-/, '')}
                </h3>
                <Button size="sm" variant="outline" onClick={() => setPreview(undefined)}>
                  Close preview
                </Button>
              </div>
              {preview.type === 'application/pdf' ? (
                <iframe
                  title="Study material PDF preview"
                  src={preview.url}
                  className="h-[55dvh] w-full rounded-xl border"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <img
                  src={preview.url}
                  alt={preview.name}
                  className="max-h-[55dvh] w-full rounded-xl object-contain"
                />
              )}
            </section>
          )}
        </>
      )}
    </Dialog>
  );
}

function MaterialForm({
  subject,
  initial,
  done,
  close,
  pending,
  saving,
}: {
  subject: MaterialSubject;
  initial: SubjectMaterial | null;
  done: () => Promise<void>;
  close: () => void;
  pending: (v: boolean) => void;
  saving: (v: boolean) => void;
}) {
  const a = useAuth(),
    attempt = useRef<{ fingerprint: string; key: string; path?: string } | undefined>(undefined);
  const [title, setTitle] = useState(initial?.title || ''),
    [body, setBody] = useState(initial?.body || ''),
    [file, setFile] = useState<File>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const dirty = title !== (initial?.title || '') || body !== (initial?.body || '') || !!file;
  useUnsavedChanges(dirty || busy);
  useEffect(() => {
    pending(dirty || busy);
    saving(busy);
    return () => {
      pending(false);
      saving(false);
    };
  }, [dirty, busy, pending, saving]);
  const cancel = () => {
    if (!busy && (!dirty || window.confirm('Discard the unsaved material?'))) close();
  };
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError('');
        try {
          if (!title.trim()) throw new Error('Enter a title.');
          if (!body.trim() && !file && !initial?.has_attachment)
            throw new Error('Add notes or choose a file.');
          const fingerprint = JSON.stringify([
            title.trim(),
            body.trim(),
            file?.name,
            file?.size,
            file?.lastModified,
          ]);
          if (attempt.current?.fingerprint !== fingerprint)
            attempt.current = { fingerprint, key: crypto.randomUUID() };
          const context = {
            userId: a.me!.id,
            schoolId: sessionStorage.getItem('vidyalayaa.school') || '',
          };
          let storage_path: string | undefined = attempt.current.path;
          if (file && !storage_path) {
            if (file.size > 10 * 1024 * 1024 || !file.size)
              throw new Error('Choose a non-empty file up to 10 MB.');
            if (!/\.(pdf|png|jpe?g)$/i.test(file.name))
              throw new Error('Choose a PDF, PNG or JPEG.');
            const filename = file.name
              .replace(/[^a-zA-Z0-9._-]/g, '_')
              .slice(-100)
              .replace(/\.(PDF|PNG|JPG|JPEG)$/i, (m) => m.toLowerCase());
            const ticket = await api<{ path: string; token: string }>(
              '/materials/upload',
              {
                method: 'POST',
                body: JSON.stringify({
                  class_id: subject.classId,
                  subject_id: subject.subjectId,
                  filename,
                }),
              },
              true,
              'json',
              context,
            );
            if (!supabase) throw new Error('Sign in before uploading.');
            const result = await supabase.storage
              .from('school-documents')
              .uploadToSignedUrl(ticket.path, ticket.token, file);
            if (result.error) throw new Error('The file could not be uploaded. Please try again.');
            storage_path = ticket.path;
            attempt.current.path = ticket.path;
          }
          await api(
            `/resources/assignments${initial ? '/' + initial.id : ''}`,
            {
              method: initial ? 'PATCH' : 'POST',
              headers: { 'Idempotency-Key': attempt.current.key },
              body: JSON.stringify({
                ...(initial
                  ? {}
                  : { class_id: subject.classId, subject_id: subject.subjectId, kind: 'MATERIAL' }),
                title: title.trim(),
                body: body.trim() || null,
                ...(storage_path ? { storage_path } : {}),
              }),
            },
            true,
            'json',
            context,
          );
          await done();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3 className="font-semibold">{initial ? 'Edit study material' : 'New study material'}</h3>
      <label className="block text-sm">
        Material title
        <input
          className="input mt-2"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={500}
          disabled={busy}
        />
      </label>
      <label className="block text-sm">
        Notes or description
        <textarea
          className="input mt-2 min-h-28"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={10000}
          disabled={busy}
        />
      </label>
      <label className="block text-sm">
        Material file
        <input
          className="input mt-2"
          type="file"
          accept=".pdf,.png,.jpg,.jpeg"
          disabled={busy}
          onChange={(e) => setFile(e.target.files?.[0])}
        />
      </label>
      <p className="text-xs text-stone-500">
        Private PDF, PNG or JPEG, up to 10 MB.{' '}
        {initial?.has_attachment
          ? 'Your current file is kept unless you choose a replacement.'
          : 'You can also share text notes without a file.'}
      </p>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={cancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="lime" disabled={busy}>
          {busy ? 'Uploading and saving…' : 'Save material'}
        </Button>
      </div>
    </form>
  );
}
