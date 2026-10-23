import { beforeAll, afterAll, it, expect } from 'vitest';
import pg from 'pg';
import type { PGlite } from '@electric-sql/pglite';
import { fixture } from '../helpers/database.js';
import { transaction } from '../../apps/api/src/lib/db.js';
import { collectFeePayment } from '../../apps/api/src/modules/school/fees.js';
import type { Actor } from '../../apps/api/src/middleware/auth.js';
import { feeCollectionSchema } from '@vidyalayaa/contracts';
const url = process.env.TEST_DATABASE_URL;
if (process.env.CI && !url)
  throw new Error('CI must provide TEST_DATABASE_URL for payment concurrency checks.');
let owner: pg.Pool, api: pg.Pool, f: Awaited<ReturnType<typeof fixture>>, actor: Actor;
beforeAll(async () => {
  if (!url) return;
  const target = new URL(url);
  if (!target.pathname.endsWith('_test') || !['localhost', '127.0.0.1'].includes(target.hostname))
    throw new Error('Use a disposable local _test database.');
  owner = new pg.Pool({ connectionString: url, ssl: false });
  api = new pg.Pool({ connectionString: url, ssl: false, max: 4, options: '-c role=app_api' });
  f = await fixture(owner as unknown as Pick<PGlite, 'query'>);
  actor = {
    id: f.admin,
    full_name: 'Native finance test',
    active: { role: 'school_admin' },
    context: { schoolId: f.schoolA, userId: f.admin },
  } as Actor;
});
afterAll(async () => {
  await Promise.all([owner?.end(), api?.end()]);
});
async function fee() {
  return (
    await owner.query(
      "INSERT INTO fee_records(school_id,student_id,academic_session_id,fee_type,amount_due,due_on,status) VALUES($1,$2,$3,'Concurrent payment test',100,'2026-01-01','UNPAID') RETURNING id",
      [f.schoolA, f.student, f.session],
    )
  ).rows[0].id as string;
}
const post = (id: string, amount: number, key: string) =>
  transaction(api, actor.context, (tx) =>
    collectFeePayment(
      tx,
      actor,
      feeCollectionSchema.parse({
        student_id: f.student,
        academic_session_id: f.session,
        payment_date: '2026-01-01',
        payment_method: 'CASH',
        allocations: [{ fee_id: id, amount }],
      }),
      key,
    ),
  );
it.skipIf(!url)('two database connections cannot overpay the same installment', async () => {
  const id = await fee(),
    results = await Promise.allSettled([
      post(id, 80, crypto.randomUUID()),
      post(id, 80, crypto.randomUUID()),
    ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(
    (await owner.query('SELECT amount_paid FROM fee_records WHERE id=$1', [id])).rows[0]
      .amount_paid,
  ).toBe('80.00');
  expect(
    (
      await owner.query(
        'SELECT count(*)::int AS count FROM fee_payment_allocations WHERE fee_id=$1',
        [id],
      )
    ).rows[0].count,
  ).toBe(1);
});
it.skipIf(!url)(
  'simultaneous retries commit only one payment and return the same receipt',
  async () => {
    const id = await fee(),
      key = crypto.randomUUID(),
      [one, two] = await Promise.all([post(id, 25, key), post(id, 25, key)]);
    expect(one).toEqual(two);
    expect(
      (await owner.query('SELECT amount_paid FROM fee_records WHERE id=$1', [id])).rows[0]
        .amount_paid,
    ).toBe('25.00');
  },
);
it.skipIf(!url)(
  'payments against different installments serialize account balance snapshots',
  async () => {
    const one = await fee(),
      two = await fee();
    const before = Number(
      (
        await owner.query(
          "SELECT coalesce(sum(amount_due-amount_paid),0) AS balance FROM fee_records WHERE school_id=$1 AND student_id=$2 AND academic_session_id=$3 AND status<>'WAIVED'",
          [f.schoolA, f.student, f.session],
        )
      ).rows[0].balance,
    );
    const results = await Promise.all([
      post(one, 50, crypto.randomUUID()),
      post(two, 50, crypto.randomUUID()),
    ]);
    expect(results.map((p) => Number(p.receipt.balance_after)).sort((a, b) => a - b)).toEqual([
      before - 100,
      before - 50,
    ]);
  },
);
it.skipIf(!url)('concurrent reversals leave one correction and a zero paid balance', async () => {
  const id = await fee(),
    payment = await post(id, 100, crypto.randomUUID()),
    reverse = () =>
      transaction(api, actor.context, (tx) =>
        tx.query(
          "INSERT INTO fee_payment_reversals(school_id,payment_id,reason,recorded_by) VALUES($1,$2,'Correct duplicate collection',$3)",
          [f.schoolA, payment.id, f.admin],
        ),
      );
  const results = await Promise.allSettled([reverse(), reverse()]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(
    (await owner.query('SELECT amount_paid FROM fee_records WHERE id=$1', [id])).rows[0]
      .amount_paid,
  ).toBe('0.00');
  expect(
    (
      await owner.query(
        'SELECT count(*)::int AS count FROM fee_payment_reversals WHERE payment_id=$1',
        [payment.id],
      )
    ).rows[0].count,
  ).toBe(1);
});
