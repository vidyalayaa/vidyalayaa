import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MAX_PROFILE_ARCHIVE_BYTES,
  type Page,
  type PersonKind,
  type PhotoAssignment,
  type PhotoCandidate,
  type PhotoImportResult,
  type PhotoPreview,
} from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { ErrorState, Loading } from '../../components/common';
import Pagination from '../../components/Pagination';

function CandidateList({
  kind,
  onChoose,
  missing = false,
}: {
  kind: PersonKind;
  onChoose?: (person: PhotoCandidate) => void;
  missing?: boolean;
}) {
  const a = useAuth();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: [a.school, 'photo-candidates', a.me?.id, kind, search, missing, page],
    queryFn: ({ signal }) =>
      api<Page<PhotoCandidate>>(
        `/profiles/${kind}/candidates?search=${encodeURIComponent(search)}&page=${page}&page_size=10${missing ? '&missing=1' : ''}`,
        { signal },
      ),
  });
  return (
    <div className="space-y-2 rounded-xl border border-line bg-surface p-3">
      <label className="field-label block">
        {missing ? 'Find a profile without a photo' : 'Find a profile by name or ID'}
        <input
          type="search"
          className="input mt-1"
          maxLength={120}
          value={search}
          onChange={(e) => {
            setSearch(e.currentTarget.value);
            setPage(1);
          }}
        />
      </label>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} />
      ) : q.data?.data.length ? (
        <ul className="divide-y divide-line">
          {q.data.data.map((person) => (
            <li
              key={person.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
            >
              <span className="min-w-0 break-words">
                {person.name} · {person.code}
                {person.photo_id ? ' · Existing photo' : ''}
              </span>
              {onChoose && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onChoose(person)}
                  aria-label={`Match to ${person.name} (${person.code})`}
                >
                  Match
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-stone-600">No matching profiles.</p>
      )}
      <Pagination total={q.data?.total} page={page} pageSize={q.data?.page_size} onPage={setPage} />
    </div>
  );
}

export default function PhotoImportDialog({
  kind,
  close,
}: {
  kind: PersonKind;
  close: () => void;
}) {
  const a = useAuth();
  const qc = useQueryClient();
  const [archive, setArchive] = useState<File>();
  const [preview, setPreview] = useState<PhotoPreview>();
  const [targets, setTargets] = useState<Record<number, PhotoCandidate>>({});
  const [confirmed, setConfirmed] = useState<Record<number, boolean>>({});
  const [matching, setMatching] = useState<number>();
  const [showMissing, setShowMissing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<PhotoImportResult>();
  const prefix = `/profiles/${kind}/photos`;
  const idName = kind === 'student' ? 'admission number' : 'employee ID';
  const limits = useQuery({
    queryKey: [a.school, 'profile-photo-limits', kind],
    queryFn: () => api<{ photo_bytes: number }>(`/profiles/${kind}/photo-limits`),
  });
  const matches = Object.entries(targets);
  const duplicateTargets =
    new Set(Object.values(targets).map((person) => person.id)).size !== matches.length;
  const needsConfirmation = matches.some(
    ([index, person]) => person.photo_id && !confirmed[Number(index)],
  );

  function setTarget(index: number, person?: PhotoCandidate) {
    setTargets((old) => {
      const next = { ...old };
      if (person) next[index] = person;
      else delete next[index];
      return next;
    });
    setConfirmed((old) => ({ ...old, [index]: false }));
    setMatching(undefined);
  }

  async function request(commit: boolean) {
    if (!archive || !a.me?.id || !a.school || pending) return;
    const context = { userId: a.me.id, schoolId: a.requestSchool };
    const body = new FormData();
    body.append('archive', archive);
    setPending(true);
    setError('');
    setMatching(undefined);
    try {
      if (commit && preview) {
        const assignments: PhotoAssignment[] = matches.map(([key, person]) => ({
          index: Number(key),
          person_id: person.id,
          expected_photo_id: person.photo_id,
          replace: Boolean(confirmed[Number(key)]),
        }));
        body.append(
          'manifest',
          JSON.stringify({ archive_hash: preview.archive_hash, assignments }),
        );
        setResult(
          await api<PhotoImportResult>(
            prefix + '/import',
            { method: 'POST', body },
            true,
            'json',
            context,
          ),
        );
        await qc.invalidateQueries({ queryKey: [a.school] });
      } else {
        setPreview(undefined);
        setResult(undefined);
        setConfirmed({});
        const data = await api<PhotoPreview>(
          prefix + '/preview',
          { method: 'POST', body },
          true,
          'json',
          context,
        );
        const candidates = new Map(data.candidates.map((person) => [person.id, person]));
        setTargets(
          Object.fromEntries(
            data.photos.flatMap((photo) => {
              const match = photo.matched && candidates.get(photo.matched);
              return match ? [[photo.index, match]] : [];
            }),
          ),
        );
        setPreview(data);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open
      title="Import profile photos"
      onOpenChange={(open) => {
        if (!open && !pending) close();
      }}
      description={`Import student or staff records first. Name each image with the exact ${idName}, then review the matches before saving.`}
    >
      <div className="space-y-4">
        <label className="field-label block">
          Photo ZIP file
          <input
            type="file"
            accept=".zip"
            className="input mt-2"
            disabled={pending}
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              setArchive(file && file.size <= MAX_PROFILE_ARCHIVE_BYTES ? file : undefined);
              setError(
                file && file.size > MAX_PROFILE_ARCHIVE_BYTES
                  ? 'Choose a ZIP no larger than 32 MB.'
                  : '',
              );
              setPreview(undefined);
              setResult(undefined);
              setTargets({});
              setMatching(undefined);
              setShowMissing(false);
            }}
          />
        </label>
        <p className="text-xs text-stone-600">
          JPG, JPEG, PNG, WebP · 200 files and 32 MB per ZIP.
          {limits.data &&
            ` Up to ${(limits.data.photo_bytes / 1048576).toFixed(1)} MB per image.`}{' '}
          Keep leading zeros in filenames.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!archive || pending}
            onClick={() => void request(false)}
          >
            {pending && !preview ? 'Reviewing ZIP…' : preview ? 'Refresh preview' : 'Preview ZIP'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => setShowMissing((open) => !open)}
            aria-expanded={showMissing}
          >
            {showMissing ? 'Hide profiles missing photos' : 'Show profiles missing photos'}
          </Button>
        </div>
        {showMissing && <CandidateList kind={kind} missing />}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        {result && (
          <div className="notice space-y-2" role="status">
            <p>
              {result.saved} photos saved · {result.failed.length} failed · {result.missing}{' '}
              profiles still missing photos
            </p>
            {result.failed.length > 0 && (
              <ul className="list-disc pl-5">
                {result.failed.map((row) => (
                  <li key={row.index}>
                    {preview?.photos[row.index]?.filename}: {row.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {preview && !result && (
          <>
            <div className="notice text-sm" role="status">
              {matches.length} matched ·{' '}
              {preview.photos.filter((photo) => !photo.issue && !targets[photo.index]).length}{' '}
              unmatched · {preview.photos.filter((photo) => photo.duplicate).length} files with
              duplicate IDs · {preview.photos.filter((photo) => photo.issue).length} invalid files ·{' '}
              {preview.missing} profiles currently missing photos
              {!duplicateTargets && (
                <p className="mt-1">
                  {Math.max(
                    0,
                    preview.missing - matches.filter(([, person]) => !person.photo_id).length,
                  )}{' '}
                  profiles will still need photos after these matches.
                </p>
              )}
            </div>
            <fieldset disabled={pending} className="space-y-2">
              {preview.photos.map((photo) => {
                const person = targets[photo.index];
                return (
                  <div key={photo.index} className="space-y-2 rounded-xl border border-line p-3">
                    <div className="flex flex-wrap items-center gap-3">
                      {photo.thumbnail && (
                        <img
                          src={photo.thumbnail}
                          alt=""
                          className="size-12 shrink-0 rounded-lg object-cover"
                        />
                      )}
                      <div className="min-w-0 flex-1 break-words text-sm">
                        <p className="font-semibold">{photo.filename}</p>
                        <p className="text-stone-600">
                          {photo.issue ||
                            (person ? `${person.name} · ${person.code}` : 'Unmatched')}
                        </p>
                        {photo.duplicate && (
                          <p className="text-xs text-stone-600">
                            Duplicate ID · review the match manually.
                          </p>
                        )}
                      </div>
                      {!photo.issue && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-expanded={matching === photo.index}
                          aria-label={`Match ${photo.filename} manually`}
                          onClick={() =>
                            setMatching(matching === photo.index ? undefined : photo.index)
                          }
                        >
                          Match manually
                        </Button>
                      )}
                      {person && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setTarget(photo.index)}
                        >
                          Skip
                        </Button>
                      )}
                    </div>
                    {person?.photo_id && (
                      <label className="flex items-start gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={Boolean(confirmed[photo.index])}
                          onChange={(e) =>
                            setConfirmed({ ...confirmed, [photo.index]: e.currentTarget.checked })
                          }
                        />
                        Replace existing photo for {person.name}
                      </label>
                    )}
                    {matching === photo.index && (
                      <CandidateList
                        key={photo.index}
                        kind={kind}
                        onChoose={(target) => setTarget(photo.index, target)}
                      />
                    )}
                  </div>
                );
              })}
            </fieldset>
            {duplicateTargets && (
              <p className="field-error" role="alert">
                Choose only one image per profile.
              </p>
            )}
            <Button
              type="button"
              variant="lime"
              disabled={pending || !matches.length || needsConfirmation || duplicateTargets}
              onClick={() => void request(true)}
            >
              {pending ? 'Saving photos…' : `Import ${matches.length} matched photos`}
            </Button>
          </>
        )}
      </div>
    </Dialog>
  );
}
