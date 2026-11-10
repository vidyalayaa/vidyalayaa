import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PersonKind, PersonPhoto } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { cn } from '../../lib/utils';

export function useObjectUrl(blob?: Blob) {
  const [url, setUrl] = useState<{ blob: Blob; value: string }>();
  useEffect(() => {
    if (!blob) {
      setUrl(undefined);
      return;
    }
    const value = URL.createObjectURL(blob);
    setUrl({ blob, value });
    return () => URL.revokeObjectURL(value);
  }, [blob]);
  return url && url.blob === blob ? url.value : undefined;
}

export function PersonAvatar({
  kind,
  id,
  photo,
  name,
  className,
  decorative = false,
}: {
  kind: PersonKind;
  id?: string;
  photo?: string | null;
  name: string;
  className?: string;
  decorative?: boolean;
}) {
  const a = useAuth();
  const container = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (visible || !photo || !container.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setVisible(true);
      },
      { rootMargin: '120px' },
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [photo, visible]);
  const blob = useQuery({
    queryKey: [a.school, 'person-photo', a.me?.id, kind, id, photo],
    enabled: Boolean(visible && a.school && a.me?.id && id && photo),
    queryFn: ({ signal }) =>
      api<Blob>(`/profiles/${kind}/${id}/photo/${photo}`, { signal }, true, 'blob'),
    staleTime: 60_000,
    gcTime: 60_000,
    retry: false,
  });
  const url = useObjectUrl(blob.data);
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
  return (
    <span
      ref={container}
      className={cn(
        'inline-flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-lime-100 text-sm font-bold text-lime-900',
        className,
      )}
      aria-hidden={decorative || undefined}
    >
      {url ? (
        <img
          src={url}
          alt={decorative ? '' : `${name} profile photo`}
          className="size-full object-cover"
        />
      ) : (
        <span
          role={decorative ? undefined : 'img'}
          aria-label={decorative ? undefined : 'No profile photo recorded'}
        >
          {initials || '—'}
        </span>
      )}
    </span>
  );
}

export function OwnProfileAvatar({
  className,
  decorative = true,
}: {
  className?: string;
  decorative?: boolean;
}) {
  const a = useAuth();
  const role = a.me?.school?.role;
  const photo = useQuery({
    queryKey: [a.school, 'own-photo-reference', a.me?.id],
    enabled: Boolean(role && role !== 'parent' && a.me?.id && a.school),
    queryFn: ({ signal }) =>
      api<(PersonPhoto & { kind: PersonKind }) | null>('/profiles/me/photo-reference', { signal }),
  });
  return (
    <PersonAvatar
      kind={photo.data?.kind || 'staff'}
      id={photo.data?.id}
      photo={photo.data?.photo_id}
      name={a.me?.full_name || 'Vidyalayaa'}
      className={className}
      decorative={decorative}
    />
  );
}
