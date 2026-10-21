import { useState, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Receipt, Printer, X, CreditCard, ArrowRight } from 'lucide-react';
import { Dialog } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { api, useAuth } from '../../lib/auth';

interface FeeRecord {
  id: string;
  student_id: string;
  fee_type: string;
  amount_due: number | string;
  amount_paid: number | string;
  currency?: string;
  due_on?: string;
  status: string;
}

interface PaymentReceipt {
  receipt_no: string;
  amount_paid_now: number;
  payment_method: string;
  note: string;
  date: string;
}

export default function FeePaymentDialog({
  fee,
  close,
}: {
  fee: FeeRecord | null;
  close: () => void;
}) {
  const a = useAuth(),
    qc = useQueryClient();

  const totalDue = Number(fee?.amount_due) || 0;
  const currentPaid = Number(fee?.amount_paid) || 0;
  const outstanding = Math.max(0, totalDue - currentPaid);

  const [amount, setAmount] = useState<number>(outstanding);
  const [method, setMethod] = useState<
    'CASH' | 'UPI' | 'CHEQUE' | 'BANK_TRANSFER' | 'CARD' | 'OTHER'
  >('CASH');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<PaymentReceipt | null>(null);
  const retry = useRef({ body: '', key: crypto.randomUUID() });

  const mutation = useMutation({
    mutationFn: async () => {
      if (!fee) return null;
      const body = JSON.stringify({
        amount: Number(amount),
        payment_method: method,
        note: note.trim() || undefined,
      });
      if (retry.current.body !== body) retry.current = { body, key: crypto.randomUUID() };
      return api<{ receipt: PaymentReceipt }>(`/fees/${fee.id}/pay`, {
        method: 'POST',
        headers: { 'Idempotency-Key': retry.current.key },
        body,
      });
    },
    onSuccess: async (data) => {
      await qc.invalidateQueries({ queryKey: [a.school] });
      if (data?.receipt) {
        setReceipt(data.receipt);
      } else {
        close();
      }
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  if (!fee) return null;

  return (
    <Dialog
      open={true}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={receipt ? 'Payment Receipt' : `Record Fee Payment - ${fee.fee_type}`}
    >
      {receipt ? (
        <div className="fee-receipt space-y-5">
          <div className="rounded-xl border border-lime-200 bg-lime-50/50 p-5 text-center">
            <span className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-lime-100 text-lime-700">
              <CheckCircle2 size={26} />
            </span>
            <h3 className="text-lg font-semibold text-stone-900">Payment Recorded Successfully</h3>
            <p className="text-xs text-stone-600">Official School Receipt</p>
          </div>

          <div className="rounded-xl border border-stone-200 bg-stone-50 p-5 text-sm space-y-3 font-mono">
            <div className="flex justify-between border-b border-stone-200 pb-2">
              <span className="text-stone-500 font-sans">Receipt No.</span>
              <span className="min-w-0 break-all text-right font-bold text-stone-800">
                {receipt.receipt_no}
              </span>
            </div>
            <div className="flex justify-between border-b border-stone-200 pb-2">
              <span className="text-stone-500 font-sans">Fee Item</span>
              <span className="font-semibold text-stone-800 font-sans">{fee.fee_type}</span>
            </div>
            <div className="flex justify-between border-b border-stone-200 pb-2">
              <span className="text-stone-500 font-sans">Amount Paid</span>
              <span className="font-bold text-lime-700">
                {fee.currency || 'INR'} {Number(receipt.amount_paid_now).toLocaleString()}
              </span>
            </div>
            <div className="flex justify-between border-b border-stone-200 pb-2">
              <span className="text-stone-500 font-sans">Payment Mode</span>
              <span className="text-stone-800">{receipt.payment_method}</span>
            </div>
            <div className="flex justify-between border-b border-stone-200 pb-2">
              <span className="text-stone-500 font-sans">Date & Time</span>
              <span className="text-stone-700 font-sans">
                {new Date(receipt.date).toLocaleString('en-IN', {
                  timeZone: a.me?.school?.timezone || 'Asia/Kolkata',
                })}
              </span>
            </div>
            {receipt.note && (
              <div className="flex justify-between pt-1">
                <span className="text-stone-500 font-sans">Reference / Note</span>
                <span className="text-stone-700 font-sans">{receipt.note}</span>
              </div>
            )}
          </div>

          <div className="receipt-actions flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => {
                window.print();
              }}
            >
              <Printer size={15} />
              Print Receipt
            </Button>
            <Button variant="lime" onClick={close}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError('');
            mutation.mutate();
          }}
          className="space-y-4"
        >
          {error && (
            <div
              className="rounded-lg bg-rose-50 p-3 text-xs text-rose-700 border border-rose-200"
              role="alert"
            >
              {error}
            </div>
          )}

          <div className="grid grid-cols-3 gap-3 rounded-xl bg-stone-50 p-4 border border-stone-200">
            <div>
              <p className="text-xs text-stone-500">Total Billed</p>
              <p className="text-sm font-semibold text-stone-800">
                {fee.currency || 'INR'} {totalDue.toLocaleString()}
              </p>
            </div>
            <div>
              <p className="text-xs text-stone-500">Already Paid</p>
              <p className="text-sm font-semibold text-stone-600">
                {fee.currency || 'INR'} {currentPaid.toLocaleString()}
              </p>
            </div>
            <div>
              <p className="text-xs text-stone-500">Outstanding</p>
              <p className="text-sm font-bold text-rose-600">
                {fee.currency || 'INR'} {outstanding.toLocaleString()}
              </p>
            </div>
          </div>

          <div>
            <label htmlFor="pay-amount" className="field-label">
              Payment Amount ({fee.currency || 'INR'})
            </label>
            <input
              id="pay-amount"
              type="number"
              step="0.01"
              min="0.01"
              max={outstanding}
              required
              className="input text-base font-semibold"
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
            />
            {outstanding > 0 && amount !== outstanding && (
              <button
                type="button"
                className="mt-1 text-xs text-lime-700 hover:underline"
                onClick={() => setAmount(outstanding)}
              >
                Set to full outstanding ({fee.currency || 'INR'} {outstanding.toLocaleString()})
              </button>
            )}
          </div>

          <div>
            <label htmlFor="pay-method" className="field-label">
              Payment Method
            </label>
            <select
              id="pay-method"
              className="input"
              value={method}
              onChange={(e) => setMethod(e.target.value as typeof method)}
            >
              <option value="CASH">Cash Deposit</option>
              <option value="UPI">UPI / QR Code</option>
              <option value="CHEQUE">Bank Cheque</option>
              <option value="BANK_TRANSFER">Direct Bank Transfer / NEFT / RTGS</option>
              <option value="CARD">Debit / Credit Card</option>
              <option value="OTHER">Other</option>
            </select>
          </div>

          <div>
            <label htmlFor="pay-note" className="field-label">
              Transaction Note / Reference Number <span>optional</span>
            </label>
            <input
              id="pay-note"
              type="text"
              placeholder="e.g. UTR / Cheque #104928"
              className="input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-stone-200">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="lime"
              disabled={mutation.isPending || !amount || amount <= 0}
            >
              {mutation.isPending ? 'Processing…' : 'Confirm Payment'}
              <ArrowRight size={14} />
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
