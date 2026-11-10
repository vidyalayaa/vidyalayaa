import { fromBufferPromise, type Entry, type ZipFile } from 'yauzl';
import { readSheet } from 'read-excel-file/node';
import sharp from 'sharp';
import { MAX_PROFILE_PHOTOS_PER_ARCHIVE } from '@vidyalayaa/contracts';
import { ApiError } from '../../lib/errors.js';

const MB = 1024 * 1024;
export const MAX_PROFILE_WORKBOOK_BYTES = 2 * MB;
export const photoExtension = /\.(jpg|jpeg|png|webp)$/i;
const imageFormats = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp' } as const;
const archiveError = () =>
  new ApiError(
    422,
    'INVALID_ARCHIVE',
    'Choose a valid, unencrypted archive within the upload limits.',
  );

async function openArchive(
  file: Buffer,
  entries: number,
  unpackedBytes: number,
  visit: (zip: ZipFile, entry: Entry) => Promise<void>,
) {
  let zip: ZipFile | undefined;
  try {
    zip = await fromBufferPromise(file, {
      lazyEntries: true,
      validateEntrySizes: true,
      strictFileNames: true,
    });
    if (zip.entryCount > entries) throw archiveError();
    const names = new Set<string>();
    let bytes = 0;
    for await (const entry of zip.eachEntry()) {
      bytes += entry.uncompressedSize;
      if (
        bytes > unpackedBytes ||
        entry.isEncrypted() ||
        names.has(entry.fileName) ||
        ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000
      )
        throw archiveError();
      names.add(entry.fileName);
      if (!entry.fileName.endsWith('/')) await visit(zip, entry);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw archiveError();
  } finally {
    zip?.close();
  }
}

async function entryBytes(zip: ZipFile, entry: Entry, limit: number) {
  if (entry.uncompressedSize > limit) throw archiveError();
  const stream = await zip.openReadStreamPromise(entry);
  const parts: Buffer[] = [];
  let bytes = 0;
  for await (const part of stream) {
    bytes += part.length;
    if (bytes > limit) throw archiveError();
    parts.push(part);
  }
  return Buffer.concat(parts, bytes);
}

export async function normalizePhoto(bytes: Buffer, filename: string) {
  const extension = filename.match(photoExtension)?.[1]?.toLowerCase() as
    | keyof typeof imageFormats
    | undefined;
  if (!extension)
    throw new ApiError(422, 'INVALID_PHOTO', 'Choose a JPG, JPEG, PNG, or WebP image.');
  try {
    const image = sharp(bytes, { failOn: 'warning', limitInputPixels: 24_000_000 });
    const metadata = await image.metadata();
    if (
      metadata.format !== imageFormats[extension] ||
      (metadata.pages || 1) !== 1 ||
      metadata.width < 48 ||
      metadata.height < 48
    )
      throw new Error('Invalid image');
    return await image
      .rotate()
      .resize(480, 480, { fit: 'cover', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 83 })
      .toBuffer();
  } catch {
    throw new ApiError(
      422,
      'INVALID_PHOTO',
      'Use a valid, single-frame image at least 48 × 48 pixels and no more than 24 megapixels.',
    );
  }
}

export function normalizedPersonCode(code: string) {
  return code.trim().normalize('NFKC').toLowerCase();
}

export async function readPhotoArchive(file: Buffer, photoLimit: number, selected?: Set<number>) {
  const result: {
    index: number;
    filename: string;
    code: string;
    bytes?: Buffer;
    issue?: string;
  }[] = [];
  await openArchive(file, 600, 80 * MB, async (zip, entry) => {
    const filename = entry.fileName.split('/').at(-1)!;
    if (filename.startsWith('.') || entry.fileName.startsWith('__MACOSX/')) return;
    const index = result.length;
    if (index >= MAX_PROFILE_PHOTOS_PER_ARCHIVE)
      throw new ApiError(422, 'PHOTO_LIMIT', 'Upload at most 200 files per ZIP.');
    const code = normalizedPersonCode(filename.replace(photoExtension, ''));
    const row: (typeof result)[number] = { index, filename, code };
    result.push(row);
    if (filename.length > 240 || /[\u0000-\u001f\u007f]/u.test(filename)) {
      row.filename = filename.slice(0, 240);
      row.code = '';
      row.issue = 'Invalid filename';
    } else if (!photoExtension.test(filename)) row.issue = 'Unsupported file type';
    else if (entry.uncompressedSize > photoLimit) row.issue = 'File exceeds the photo size limit';
    else if (!selected || selected.has(index)) {
      const bytes = await entryBytes(zip, entry, photoLimit);
      try {
        row.bytes = await normalizePhoto(bytes, filename);
      } catch {
        row.issue = 'Invalid or unsupported image contents';
      }
    }
  });
  if (!result.length)
    throw new ApiError(422, 'EMPTY_ARCHIVE', 'The ZIP contains no files to review.');
  return result;
}

export async function photoThumbnail(bytes: Buffer) {
  const thumbnail = await sharp(bytes)
    .resize(72, 72, { fit: 'cover' })
    .jpeg({ quality: 68 })
    .toBuffer();
  return 'data:image/jpeg;base64,' + thumbnail.toString('base64');
}

export async function workbookCsv(file: Buffer) {
  await openArchive(file, 150, 12 * MB, async (zip, entry) => {
    const bytes = await entryBytes(zip, entry, 3 * MB);
    if (!/\.(xml|rels)$/i.test(entry.fileName))
      throw new ApiError(
        422,
        'INVALID_WORKBOOK',
        'Use a plain .xlsx workbook without embedded files or macros.',
      );
    const xml = bytes.toString('utf8');
    if (xml.includes('\0') || /<!DOCTYPE/i.test(xml)) throw archiveError();
    for (const tag of xml.matchAll(/<(?:[\w.-]+:)?(?:row|c)\s+[^>]*>/g)) {
      const address = tag[0].match(/\sr\s*=\s*["']([^"']*)["']/)?.[1];
      if (!address) continue;
      const cell = /^([A-Z]{0,2})(\d{1,3})$/.exec(address);
      if (!cell || Number(cell[2]) > 501 || (cell[1].length === 2 && cell[1] > 'BL'))
        throw new ApiError(
          422,
          'WORKBOOK_LIMIT',
          'Use at most 500 records and 64 columns on the worksheet.',
        );
    }
  });
  try {
    const rows = await readSheet(file, 1);
    if (rows.length < 2 || rows.length > 501 || rows.some((row) => row.length > 64))
      throw new Error();
    const csv = rows
      .map((row) =>
        row
          .map((value) => {
            const cell =
              value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '');
            return '"' + cell.replaceAll('"', '""') + '"';
          })
          .join(','),
      )
      .join('\r\n');
    if (Buffer.byteLength(csv) > 512_000) throw new Error();
    return csv;
  } catch {
    throw new ApiError(
      422,
      'INVALID_WORKBOOK',
      'Use a valid .xlsx file with import headers in the first worksheet and up to 500 records.',
    );
  }
}
