/** Keeps one slow school from stopping delivery for the rest of the fleet. */
export async function forSchools<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('INVALID_CONCURRENCY');
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        await work(item!);
      }
    }),
  );
}
