import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  feeCollectionSchema,
  feeMethods,
  type FeeAssessment,
  type FeeReceipt as Receipt,
} from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { Dialog } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import FeeReceipt, { feeAmount } from './FeeReceipt';

export default function CollectPayment({
  fees,
  studentId,
  year,
  close,
  initialId,
}: {
  fees: FeeAssessment[];
  studentId: string;
  year: string;
  close: () => void;
  initialId?: string;
}) {
  const a = useAuth(),
    qc = useQueryClient(),
    [amounts, setAmounts] = useState<Record<string, string>>(
      Object.fromEntries(
        fees.map((f) => [
          f.id,
          f.id === initialId ? (Number(f.amount_due) - Number(f.amount_paid)).toFixed(2) : '',
        ]),
      ),
    ),
    [date, setDate] = useState(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: a.me?.school?.timezone || 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date()),
    ),
    [method, setMethod] = useState<(typeof feeMethods)[number]>('CASH'),
    [reference, setReference] = useState(''),
    [note, setNote] = useState(''),
    [receiptNo, setReceiptNo] = useState(''),
    [review, setReview] = useState(false),
    [error, setError] = useState(''),
    [receipt, setReceipt] = useState<Receipt>();
  const retry = useRef({ body: '', key: crypto.randomUUID() });
  const values = () =>
    feeCollectionSchema.parse({
      student_id: studentId,
      academic_session_id: year,
      payment_date: date,
      payment_method: method,
      reference,
      note,
      ...(receiptNo ? { receipt_no: receiptNo } : {}),
      allocations: fees
        .filter((f) => Number(amounts[f.id]) > 0)
        .map((f) => ({ fee_id: f.id, amount: Number(amounts[f.id]) })),
    });
  const mutation = useMutation({
    mutationFn: () => {
      const body = JSON.stringify(values());
      if (retry.current.body !== body) retry.current = { body, key: crypto.randomUUID() };
      return api<{ receipt: Receipt }>('/fees/payments', {
        method: 'POST',
        headers: { 'Idempotency-Key': retry.current.key },
        body,
      });
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: [a.school] });
      setReceipt(r.receipt);
    },
    onError: (e: Error) => {
      setError(e.message);
      setReview(false);
    },
  });
  const exit = () => {
    if (
      !mutation.isPending &&
      (!Object.values(amounts).some(Boolean) || window.confirm('Discard this unrecorded payment?'))
    )
      close();
  };
  if (receipt) return <FeeReceipt receipt={receipt} close={close} />;
  const total = fees.reduce((s, f) => s + Math.round(Number(amounts[f.id] || 0) * 100), 0) / 100,
    currencies = new Set(fees.filter((f) => Number(amounts[f.id]) > 0).map((f) => f.currency));
  return (
    <Dialog
      open
      title={review ? 'Confirm fee payment' : 'Record fee payment'}
      description="Allocate the amount received to the correct fee categories and installments. This records a manual payment."
      onOpenChange={(open) => {
        if (!open) exit();
      }}
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          if (review) {
            mutation.mutate();
            return;
          }
          try {
            values();
            if (currencies.size > 1)
              throw new Error('Record different currencies in separate payments.');
            setReview(true);
          } catch (e) {
            setError(
              e instanceof Error
                ? (e as { issues?: { message: string }[] }).issues
                    ?.map((v) => v.message)
                    .join(' ') || e.message
                : 'Check payment details.',
            );
          }
        }}
      >
        {error && (
          <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800">
            {error}
          </p>
        )}
        <fieldset disabled={mutation.isPending} className="min-w-0 space-y-4">
          {review ? (
            <>
              <p className="notice">
                Confirm receipt of {feeAmount(total, [...currencies][0])} by{' '}
                {method.replaceAll('_', ' ')} on {date}. No payment has been recorded yet.
              </p>
              <ul className="space-y-2 text-sm">
                {fees
                  .filter((f) => Number(amounts[f.id]) > 0)
                  .map((f) => (
                    <li key={f.id} className="flex justify-between gap-3">
                      <span>
                        {f.fee_type} · {f.installment_label || String(f.due_on).slice(0, 10)}
                      </span>
                      <strong>{feeAmount(amounts[f.id], f.currency)}</strong>
                    </li>
                  ))}
              </ul>
              <p className="break-words text-sm">
                Reference: {reference || '—'}
                <br />
                Receipt: {receiptNo || 'Generated automatically'}
                <br />
                Notes: {note || '—'}
              </p>
            </>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="text-sm">
                  Payment date
                  <input
                    className="input mt-2"
                    type="date"
                    required
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </label>
                <label className="text-sm">
                  Payment method
                  <select
                    className="input mt-2"
                    value={method}
                    onChange={(e) => setMethod(e.target.value as typeof method)}
                  >
                    {feeMethods.map((m) => (
                      <option key={m} value={m}>
                        {m.replaceAll('_', ' ')}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="space-y-3">
                <h3 className="font-semibold">Fee categories and installments</h3>
                {fees.map((f) => (
                  <label
                    key={f.id}
                    className="grid grid-cols-[1fr_7rem] items-center gap-3 rounded-xl border border-stone-200 p-3 text-sm"
                  >
                    <span className="min-w-0">
                      {f.fee_type}
                      <span className="mt-1 block text-xs text-stone-500">
                        {f.category === 'TRANSPORT' ? 'Transport · ' : ''}
                        {f.installment_label || String(f.due_on).slice(0, 10)}
                        <br />
                        Balance{' '}
                        {feeAmount(Number(f.amount_due) - Number(f.amount_paid), f.currency)}
                      </span>
                    </span>
                    <input
                      className="input"
                      aria-label={`Amount for ${f.fee_type} ${f.id}`}
                      type="number"
                      min="0"
                      max={(Number(f.amount_due) - Number(f.amount_paid)).toFixed(2)}
                      step="0.01"
                      placeholder="0.00"
                      value={amounts[f.id] || ''}
                      onChange={(e) => setAmounts({ ...amounts, [f.id]: e.target.value })}
                    />
                  </label>
                ))}
              </div>
              <label className="block text-sm">
                Transaction / reference number
                <input
                  className="input mt-2"
                  required={['UPI', 'BANK_TRANSFER', 'CARD', 'CHEQUE'].includes(method)}
                  maxLength={200}
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              </label>
              {a.me?.school?.role === 'school_admin' && (
                <label className="block text-sm">
                  Receipt number (optional override)
                  <input
                    className="input mt-2"
                    placeholder="Generated automatically"
                    maxLength={100}
                    value={receiptNo}
                    onChange={(e) => setReceiptNo(e.target.value)}
                  />
                  <span className="mt-1 block text-xs text-stone-500">
                    Issued receipts are corrected through reversal and replacement.
                  </span>
                </label>
              )}
              <label className="block text-sm">
                Remarks / notes
                <textarea
                  className="input mt-2"
                  maxLength={1000}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              <p className="text-right font-semibold">
                Payment total: {feeAmount(total, [...currencies][0])}
              </p>
            </>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={review ? () => setReview(false) : exit}
            >
              {review ? 'Back' : 'Cancel'}
            </Button>
            <Button type="submit" variant="lime" disabled={mutation.isPending || total <= 0}>
              {mutation.isPending ? 'Recording…' : review ? 'Confirm payment' : 'Review payment'}
            </Button>
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}
