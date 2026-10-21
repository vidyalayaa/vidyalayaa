import { useState, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CreditCard, ShieldAlert, ArrowRight, Check } from 'lucide-react';
import { Dialog } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import RecordSelect from '../../components/RecordSelect';
import { api, useAuth } from '../../lib/auth';

export function IssueCardDialog({
  open,
  close,
  initialStudentId,
}: {
  open: boolean;
  close: () => void;
  initialStudentId?: string;
}) {
  const a = useAuth(),
    qc = useQueryClient(),
    [studentId, setStudentId] = useState(initialStudentId || ''),
    [cardUid, setCardUid] = useState(''),
    [error, setError] = useState('');
  const retry = useRef({ body: '', key: crypto.randomUUID() });

  const mutation = useMutation({
    mutationFn: () => {
      const body = JSON.stringify({
        student_id: studentId,
        card_uid: cardUid.trim().toUpperCase(),
      });
      if (retry.current.body !== body) retry.current = { body, key: crypto.randomUUID() };
      return api('/cards/issue', {
        method: 'POST',
        headers: { 'Idempotency-Key': retry.current.key },
        body,
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [a.school] });
      close();
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) close();
      }}
      title="Issue NFC Student Card"
    >
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

        <div>
          <label htmlFor="card-student" className="field-label">
            Student
          </label>
          <RecordSelect
            name="student_id"
            id="card-student"
            endpoint="/resources/students"
            value={studentId}
            onChange={(v) => setStudentId(v)}
            label="student"
          />
        </div>

        <div>
          <label htmlFor="card-uid" className="field-label">
            NFC Card UID (Hex)
          </label>
          <div className="relative">
            <input
              id="card-uid"
              type="text"
              placeholder="e.g. 04A1B2C3D4"
              required
              pattern="^[0-9A-Fa-f]{8,32}$"
              title="8 to 32 hexadecimal characters (0-9, A-F)"
              className="input font-mono uppercase tracking-wider"
              value={cardUid}
              onChange={(e) =>
                setCardUid(e.target.value.replace(/[^0-9A-Fa-f]/g, '').toUpperCase())
              }
            />
            <span className="absolute right-3 top-2.5 text-stone-400">
              <CreditCard size={18} />
            </span>
          </div>
          <p className="mt-1 text-xs text-stone-500">
            Tap card on USB reader or type the 8–32 character hex serial. Any previous active card
            for this student will be retired automatically.
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-stone-200">
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="lime"
            disabled={mutation.isPending || !studentId || cardUid.length < 8}
          >
            {mutation.isPending ? 'Issuing…' : 'Issue Card'}
            <ArrowRight size={14} />
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function BlockCardDialog({
  card,
  close,
}: {
  card: { id: string; card_uid: string; student_id: string } | null;
  close: () => void;
}) {
  const a = useAuth(),
    qc = useQueryClient(),
    [status, setStatus] = useState<'BLOCKED' | 'LOST' | 'RETIRED'>('LOST'),
    [reason, setReason] = useState('Reported lost by student/parent'),
    [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      api(`/cards/${card?.id}/block`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          status,
          reason: reason.trim(),
        }),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [a.school] });
      close();
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  if (!card) return null;

  return (
    <Dialog
      open={true}
      onOpenChange={(v) => {
        if (!v) close();
      }}
      title={`Deactivate NFC Card: ${card.card_uid}`}
    >
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

        <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-3 text-xs text-amber-900 flex items-start gap-2">
          <ShieldAlert size={17} className="text-amber-700 shrink-0 mt-0.5" />
          <div>Deactivating this card revokes gate access and attendance logging immediately.</div>
        </div>

        <div>
          <label htmlFor="card-status" className="field-label">
            New Card Status
          </label>
          <select
            id="card-status"
            className="input"
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
          >
            <option value="LOST">Card Lost / Missing</option>
            <option value="BLOCKED">Card Suspended / Blocked</option>
            <option value="RETIRED">Damaged / Physically Returned</option>
          </select>
        </div>

        <div>
          <label htmlFor="card-reason" className="field-label">
            Reason for deactivation
          </label>
          <textarea
            id="card-reason"
            rows={3}
            required
            className="input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-stone-200">
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="destructive"
            disabled={mutation.isPending || !reason.trim()}
          >
            {mutation.isPending ? 'Deactivating…' : 'Deactivate Card'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
