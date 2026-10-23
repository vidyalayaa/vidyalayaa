import type { FeePayment, FeeReceipt as Receipt } from '@vidyalayaa/contracts';
import { Printer } from 'lucide-react';
import { Dialog } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
export const feeAmount = (v: unknown, currency = 'INR') =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(Number(v) || 0);
export default function FeeReceipt({
  receipt,
  payment,
  close,
}: {
  receipt: Receipt;
  payment?: FeePayment;
  close: () => void;
}) {
  return (
    <Dialog
      open
      title="Fee receipt"
      description="A retained copy of the payment as recorded. Use Print to save it as a PDF."
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <div className="fee-receipt space-y-5 text-sm">
        <div className="border-b border-stone-200 pb-4">
          <h2 className="text-xl font-semibold">{receipt.school_name}</h2>
          <p className="mt-1">Fee payment receipt</p>
          <p className="mt-2 break-all font-mono">{receipt.receipt_no}</p>
        </div>
        {payment?.reversed_at && (
          <p className="rounded-xl bg-rose-50 p-3 text-rose-800">
            Reversed — {payment.reversal_reason}. This original receipt is retained for the audit
            trail.
          </p>
        )}
        {receipt.legacy && (
          <p className="rounded-xl bg-amber-50 p-3 text-amber-900">
            Historical record.{' '}
            {receipt.payment_date
              ? 'Details available from the original payment audit.'
              : 'Original payment date and method were not recorded. This opening balance is not a new collection.'}
          </p>
        )}
        <dl className="grid grid-cols-2 gap-4">
          {Object.entries({
            Student: receipt.student_name,
            'Admission / student code': receipt.student_code,
            'Roll number': receipt.roll_number || 'Not recorded',
            'Class and section': receipt.class_label || 'Not recorded',
            'Academic year': receipt.academic_year,
            'Payment date': receipt.payment_date || 'Not recorded',
            Method: receipt.payment_method?.replaceAll('_', ' '),
            'Recorded by': receipt.recorded_by || 'Historical record',
            Reference: receipt.reference || '—',
          }).map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-xs text-stone-500">{k}</dt>
              <dd className="mt-1 break-words font-medium">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <caption className="sr-only">Fee breakdown</caption>
            <thead>
              <tr>
                <th className="p-2">Fee / installment</th>
                <th className="p-2 text-right">Amount paid</th>
              </tr>
            </thead>
            <tbody>
              {receipt.lines?.map((l, i) => (
                <tr key={i} className="border-t border-stone-100">
                  <td className="p-2">
                    {l.label}
                    <span className="block text-xs text-stone-500">{l.installment}</span>
                  </td>
                  <td className="p-2 text-right">{feeAmount(l.amount, receipt.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="rounded-xl bg-lime-50 p-4">
          <p className="flex justify-between gap-3">
            <span>Amount paid</span>
            <strong>{feeAmount(receipt.amount, receipt.currency)}</strong>
          </p>
          <p className="mt-2 flex justify-between gap-3">
            <span>Year balance after this payment</span>
            <strong>{feeAmount(receipt.balance_after, receipt.currency)}</strong>
          </p>
        </div>
        {receipt.note && <p className="break-words">Notes: {receipt.note}</p>}
        <p className="text-xs text-stone-500">
          The balance above is the snapshot when this payment was recorded. The current statement
          includes subsequent payments and reversals.
        </p>
      </div>
      <div className="receipt-actions mt-6 flex justify-end gap-2">
        <Button variant="outline" onClick={() => window.print()}>
          <Printer size={15} />
          Print / save PDF
        </Button>
        <Button variant="lime" onClick={close}>
          Done
        </Button>
      </div>
    </Dialog>
  );
}
