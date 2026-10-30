import { it, expect, vi } from 'vitest';
import { scopedDraft, clearDrafts, readDraft } from '../../apps/web/src/lib/drafts';
import {
  MarksSaveQueue,
  type QueuedMark,
  type MarksQueueSnapshot,
} from '../../apps/web/src/lib/marks-save-queue';
const job = (score = 20) => ({
  studentId: crypto.randomUUID(),
  subjectId: crypto.randomUUID(),
  score,
  remarks: null,
  label: 'Roll 1 · Mathematics',
});
it('account/school draft clearing prevents late save callbacks from resurrecting private entries', async () => {
  const key = crypto.randomUUID(),
    draft = scopedDraft(key),
    held = gate();
  const q = new MarksSaveQueue(
    async () => held.wait,
    (s) => draft.save({ jobs: s.jobs }),
  );
  q.enqueue(job());
  expect(readDraft(key).jobs).toBeDefined();
  clearDrafts();
  expect(draft.isCurrent()).toBe(false);
  q.dispose();
  held.resolve();
  await Promise.resolve();
  expect(readDraft(key)).toEqual({});
});
function gate() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const wait = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { wait, resolve, reject };
}
it('enqueues immediately and saves FIFO without blocking entry or confirming unsaved work', async () => {
  const first = gate(),
    second = gate(),
    sent: QueuedMark[] = [];
  const q = new MarksSaveQueue(
    async (mark) => {
      sent.push(mark);
      await (sent.length === 1 ? first.wait : second.wait);
    },
    () => {},
  );
  q.enqueue(job(10));
  q.enqueue(job(20));
  expect(q.snapshot().jobs).toHaveLength(2);
  expect(sent).toHaveLength(1);
  expect(q.snapshot().confirmed).toBe(0);
  first.resolve();
  await vi.waitFor(() => expect(sent).toHaveLength(2));
  expect(q.snapshot().confirmed).toBe(1);
  expect(sent.map((m) => m.score)).toEqual([10, 20]);
  second.resolve();
  await vi.waitFor(() => expect(q.snapshot().jobs).toHaveLength(0));
  expect(q.snapshot().confirmed).toBe(2);
});
it('retains failed and later saves, pauses, and retries the identical idempotency key', async () => {
  let fail = true;
  const sent: QueuedMark[] = [];
  let persisted: MarksQueueSnapshot | undefined;
  const q = new MarksSaveQueue(
    async (mark) => {
      sent.push(mark);
      if (fail) throw new Error('Connection lost');
    },
    (s) => {
      persisted = s;
    },
  );
  q.enqueue(job(0));
  q.enqueue(job(31));
  await vi.waitFor(() => expect(q.snapshot().jobs[0].status).toBe('failed'));
  expect(sent).toHaveLength(1);
  expect(q.snapshot().confirmed).toBe(0);
  expect(persisted?.jobs).toHaveLength(2);
  fail = false;
  q.retry();
  await vi.waitFor(() => expect(q.snapshot().jobs).toHaveLength(0));
  expect(sent[0].key).toBe(sent[1].key);
  expect(sent[1].score).toBe(0);
  expect(q.snapshot().confirmed).toBe(2);
});
it('preserves ordering for repeated edits to the same student', async () => {
  const held = gate(),
    sent: number[] = [];
  const q = new MarksSaveQueue(
      async (m) => {
        sent.push(m.score);
        if (sent.length === 1) await held.wait;
      },
      () => {},
    ),
    mark = job(30);
  q.enqueue(mark);
  q.enqueue({ ...mark, score: 45 });
  held.resolve();
  await vi.waitFor(() => expect(q.snapshot().confirmed).toBe(2));
  expect(sent).toEqual([30, 45]);
});
it('closing aborts requests and retains unconfirmed entries for an explicit safe resume', async () => {
  let signal: AbortSignal | undefined,
    persisted: MarksQueueSnapshot = { jobs: [], confirmed: 0 };
  const held = gate();
  const q = new MarksSaveQueue(
    async (_m, s) => {
      signal = s;
      await held.wait;
    },
    (s) => {
      persisted = s;
    },
  );
  q.enqueue(job(25));
  q.enqueue(job(40));
  const keys = q.snapshot().jobs.map((m) => m.key);
  q.dispose();
  expect(signal?.aborted).toBe(true);
  expect(persisted.jobs.every((m) => m.status === 'failed')).toBe(true);
  held.resolve();
  await Promise.resolve();
  expect(persisted.jobs).toHaveLength(2);
  const sent: string[] = [],
    restored = new MarksSaveQueue(
      async (m) => {
        sent.push(m.key);
      },
      () => {},
      persisted.jobs,
    );
  expect(sent).toHaveLength(0);
  restored.retry();
  await vi.waitFor(() => expect(restored.snapshot().confirmed).toBe(2));
  expect(sent).toEqual(keys);
});
it('permission errors retain every score and do not send later queued marks', async () => {
  const send = vi.fn(async () => {
    throw new Error('Only open exams accept marks.');
  });
  const q = new MarksSaveQueue(send, () => {});
  q.enqueue(job());
  await vi.waitFor(() => expect(q.snapshot().jobs[0].status).toBe('failed'));
  q.enqueue(job());
  expect(send).toHaveBeenCalledTimes(1);
  expect(q.snapshot().jobs).toHaveLength(2);
});
