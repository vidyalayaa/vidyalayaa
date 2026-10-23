import { it, expect } from 'vitest';
import { feeInstallments, feeMoney, feeCollectionSchema } from '@vidyalayaa/contracts';
it('generates monthly/quarterly/half-yearly/annual and one-time dates without month-end drift', () => {
  expect(feeInstallments('2026-01-31', '2026-04-30', 'MONTHLY')).toEqual([
    '2026-01-31',
    '2026-02-28',
    '2026-03-31',
    '2026-04-30',
  ]);
  expect(feeInstallments('2026-01-31', '2026-12-31', 'QUARTERLY')).toHaveLength(4);
  expect(feeInstallments('2026-01-01', '2026-12-31', 'HALF_YEARLY')).toHaveLength(2);
  expect(feeInstallments('2026-01-01', '2026-12-31', 'ANNUAL')).toHaveLength(1);
  expect(feeInstallments('2026-01-01', '2027-12-31', 'ONE_TIME')).toEqual(['2026-01-01']);
  expect(()=>feeInstallments('2026-01-01','2050-12-31','MONTHLY')).toThrow('120 installments');
});
it('rejects unsafe monetary precision and invalid dates', () => {
  for (const v of [0, -1, Infinity, 0.001, NaN]) expect(feeMoney.safeParse(v).success).toBe(false);
  expect(feeMoney.safeParse(0.29).success).toBe(true);
  expect(
    feeCollectionSchema.safeParse({
      student_id: crypto.randomUUID(),
      academic_session_id: crypto.randomUUID(),
      payment_date: '2026-02-30',
      payment_method: 'CASH',
      allocations: [{ fee_id: crypto.randomUUID(), amount: 1 }],
    }).success,
  ).toBe(false);
});
