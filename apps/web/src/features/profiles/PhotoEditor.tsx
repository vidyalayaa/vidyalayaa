import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_PROFILE_PHOTO_BYTES, type PersonKind } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { Button } from '../../components/ui/button';
import { useObjectUrl } from './PersonAvatar';

type Crop = { zoom: number; x: number; y: number };
const initialCrop: Crop = { zoom: 1, x: 50, y: 50 };
const square = 480;

function draw(canvas: HTMLCanvasElement, image: ImageBitmap, { zoom, x, y }: Crop) {
  const side = Math.min(image.width, image.height) / zoom;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(
    image,
    ((image.width - side) * x) / 100,
    ((image.height - side) * y) / 100,
    side,
    side,
    0,
    0,
    canvas.width,
    canvas.height,
  );
}

export default function PhotoEditor({
  kind,
  id,
  photo,
}: {
  kind: PersonKind;
  id: string;
  photo?: string | null;
}) {
  const a = useAuth();
  const qc = useQueryClient();
  const [file, setFile] = useState<File>();
  const [image, setImage] = useState<ImageBitmap>();
  const [crop, setCrop] = useState(initialCrop);
  const [confirm, setConfirm] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const source = useObjectUrl(file);
  const limits = useQuery({
    queryKey: [a.school, 'profile-photo-limits', kind],
    queryFn: () => api<{ photo_bytes: number }>(`/profiles/${kind}/photo-limits`),
  });
  const limit = limits.data?.photo_bytes || DEFAULT_PROFILE_PHOTO_BYTES;
  useEffect(() => {
    if (!file) return;
    let stopped = false;
    let bitmap: ImageBitmap | undefined;
    void createImageBitmap(file)
      .then((result) => {
        if (stopped) {
          result.close();
          return;
        }
        if (
          Math.min(result.width, result.height) < 48 ||
          result.width * result.height > 24_000_000
        ) {
          result.close();
          setError('Use an image from 48 × 48 pixels up to 24 megapixels.');
          return;
        }
        bitmap = result;
        setImage(result);
      })
      .catch(() => {
        if (!stopped) setError('The selected image could not be decoded.');
      });
    return () => {
      stopped = true;
      bitmap?.close();
    };
  }, [file]);
  useEffect(() => {
    if (image && canvas.current) draw(canvas.current, image, crop);
  }, [image, crop]);

  function select(next?: File) {
    setError('');
    setMessage('');
    setFile(undefined);
    setImage(undefined);
    setCrop(initialCrop);
    setConfirm(false);
    setRemoving(false);
    if (!next) return;
    if (!/\.(jpg|jpeg|png|webp)$/i.test(next.name) || next.size > limit)
      setError('Choose a JPG, JPEG, PNG, or WebP image within the displayed size limit.');
    else setFile(next);
  }

  async function save(remove: boolean) {
    if (!a.me?.id || !a.school || pending) return;
    const context = { userId: a.me.id, schoolId: a.requestSchool };
    const expected = photo || null;
    setPending(true);
    setError('');
    setMessage('');
    try {
      if (remove) {
        await api(
          `/profiles/${kind}/${id}/photo`,
          {
            method: 'DELETE',
            body: JSON.stringify({ expected_photo_id: expected }),
          },
          true,
          'json',
          context,
        );
      } else {
        if (!canvas.current) return;
        const cropped = await new Promise<Blob | null>((resolve) =>
          canvas.current!.toBlob(resolve, 'image/jpeg', 0.88),
        );
        if (!cropped) throw new Error('Could not crop this image.');
        const body = new FormData();
        body.set('image', cropped, 'profile.jpg');
        body.set('expected_photo_id', expected || '');
        body.set('replace', String(confirm));
        await api(`/profiles/${kind}/${id}/photo`, { method: 'PUT', body }, true, 'json', context);
      }
      select();
      if (input.current) input.current.value = '';
      setMessage(remove ? 'Profile photo removed.' : 'Profile photo saved.');
      await qc.invalidateQueries({ queryKey: [a.school] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <fieldset disabled={pending} className="space-y-3 rounded-2xl border border-line p-4">
      <legend className="px-2 text-sm font-semibold">Profile photograph</legend>
      <label className="field-label block">
        {photo ? 'Choose a replacement photo' : 'Choose a photo'}
        <input
          ref={input}
          type="file"
          accept=".jpg,.jpeg,.png,.webp"
          className="input mt-2"
          onChange={(e) => select(e.currentTarget.files?.[0])}
        />
      </label>
      <p className="text-xs text-stone-600">
        JPG, JPEG, PNG or WebP · up to {(limit / 1048576).toFixed(1)} MB
      </p>
      {image && (
        <>
          <div className="flex flex-wrap items-start gap-4">
            {source && (
              <img
                src={source}
                alt="Original selected image"
                className="size-28 rounded-xl bg-stone-100 object-contain"
              />
            )}
            <canvas
              ref={canvas}
              width={square}
              height={square}
              className="size-28 rounded-xl ring-2 ring-lime-400"
              aria-label="Cropped photo preview"
              role="img"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {(['zoom', 'x', 'y'] as const).map((axis) => (
              <label className="field-label block" key={axis}>
                {{ zoom: 'Zoom', x: 'Horizontal position', y: 'Vertical position' }[axis]}
                <input
                  className="mt-1 block w-full accent-focus"
                  type="range"
                  min={axis === 'zoom' ? 1 : 0}
                  max={axis === 'zoom' ? 3 : 100}
                  step={axis === 'zoom' ? 0.05 : 1}
                  value={crop[axis]}
                  onChange={(e) => setCrop({ ...crop, [axis]: Number(e.target.value) })}
                />
              </label>
            ))}
          </div>
          {photo && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={confirm}
                onChange={(e) => setConfirm(e.target.checked)}
              />
              Replace the current profile photo
            </label>
          )}
          <Button
            type="button"
            variant="lime"
            disabled={Boolean(photo && !confirm) || pending}
            onClick={() => void save(false)}
          >
            {pending ? 'Saving…' : 'Save cropped photo'}
          </Button>
        </>
      )}
      {photo &&
        (removing ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="destructive" onClick={() => void save(true)}>
              Confirm remove
            </Button>
            <Button type="button" variant="outline" onClick={() => setRemoving(false)}>
              Keep photo
            </Button>
          </div>
        ) : (
          <Button type="button" variant="outline" onClick={() => setRemoving(true)}>
            Remove photo
          </Button>
        ))}
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
    </fieldset>
  );
}
