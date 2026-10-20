import { it, expect } from 'vitest';
import { forSchools } from '../../apps/worker/src/concurrency.js';
it('bounds parallel schools and lets other schools finish while one is delayed', async () => {
  let active = 0,
    maximum = 0,
    release!: () => void;
  const blocked = new Promise<void>((r) => (release = r)),
    completed: number[] = [];
  const run = forSchools([1, 2, 3, 4], 2, async (n) => {
    maximum = Math.max(maximum, ++active);
    if (n === 1) await blocked;
    completed.push(n);
    active--;
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(completed).toEqual([2, 3, 4]);
  release();
  await run;
  expect(maximum).toBe(2);
  expect(completed).toEqual([2, 3, 4, 1]);
});
