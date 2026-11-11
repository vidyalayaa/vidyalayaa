import { pageSchema } from '@vidyalayaa/contracts';
import type { Tx } from './db.js';
import { z } from 'zod';
import { ApiError } from './errors.js';
export async function paged(tx: Tx, sql: string, args: unknown[], query: unknown) {
  const q = pageSchema.parse(query),
    next = args.length;
  const total = Number(
    (await tx.query(`SELECT count(*) FROM (${sql}) scoped_count`, args)).rows[0].count,
  );
  const data = (
    await tx.query(`${sql} LIMIT $${next + 1} OFFSET $${next + 2}`, [
      ...args,
      q.page_size,
      (q.page - 1) * q.page_size,
    ])
  ).rows;
  return { data, total, page: q.page, page_size: q.page_size };
}
export async function cursorPage(
  tx: Tx,
  select: string,
  where: string,
  args: unknown[],
  timeColumn: string,
  idColumn: string,
  idKind: 'uuid' | 'bigint',
  query: Record<string, unknown>,
) {
  const q = pageSchema.parse(query);
  let after: { at: string; id: string } | undefined;
  if (query.after !== undefined)
    try {
      const value = z.string().max(400).parse(query.after);
      after = z
        .object({
          at: z.string().datetime(),
          id: idKind === 'uuid' ? z.guid() : z.string().regex(/^[1-9][0-9]*$/),
        })
        .strict()
        .parse(JSON.parse(Buffer.from(value, 'base64url').toString()));
    } catch {
      throw new ApiError(422, 'INVALID_CURSOR', 'Choose a page from the feed navigation.');
    }
  const total = Number(
    (await tx.query(`SELECT count(*) FROM (${select} ${where}) scoped`, args)).rows[0].count,
  );
  const n = args.length,
    filter = after
      ? ` AND (${timeColumn},${idColumn})<($${n + 1}::timestamptz,$${n + 2}::${idKind})`
      : '';
  const values = after ? [...args, after.at, after.id] : [...args];
  const data = (
    await tx.query(
      `${select} ${where}${filter} ORDER BY ${timeColumn} DESC,${idColumn} DESC LIMIT $${values.length + 1}`,
      [...values, q.page_size + 1],
    )
  ).rows;
  const more = data.length > q.page_size;
  if (more) data.pop();
  const last = data.at(-1),
    timeKey = timeColumn.split('.').at(-1)!;
  return {
    data,
    total,
    page: q.page,
    page_size: q.page_size,
    next_cursor:
      more && last
        ? Buffer.from(
            JSON.stringify({ at: new Date(last[timeKey]).toISOString(), id: String(last.id) }),
          ).toString('base64url')
        : null,
  };
}
