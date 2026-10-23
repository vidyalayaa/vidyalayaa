import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  feeFrequencies,
  transportRouteSchema,
  transportAssignmentSchema,
} from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { Dialog } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
export interface FeeRoute {
  id: string;
  name: string;
  description: string;
  active: boolean;
}
export function RouteForm({ initial, close }: { initial?: FeeRoute; close: () => void }) {
  const a = useAuth(),
    qc = useQueryClient(),
    [name, setName] = useState(initial?.name || ''),
    [description, setDescription] = useState(initial?.description || ''),
    [active, setActive] = useState(initial?.active ?? true),
    [error, setError] = useState(''),
    key = useRef(crypto.randomUUID());
  const save = useMutation({
    mutationFn: () =>
      api('/fees/routes' + (initial ? '/' + initial.id : ''), {
        method: initial ? 'PATCH' : 'POST',
        headers: { 'Idempotency-Key': key.current },
        body: JSON.stringify(transportRouteSchema.parse({ name, description, active })),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [a.school] });
      close();
    },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Dialog
      open
      title={initial ? 'Edit transport route' : 'Add transport route'}
      onOpenChange={(open) => {
        if (!open && !save.isPending) close();
      }}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <fieldset disabled={save.isPending} className="space-y-4">
          <label className="block text-sm">
            Route / service name
            <input
              className="input mt-2"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            Description
            <textarea
              className="input mt-2"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Available for new assignments
          </label>
          {error && (
            <p role="alert" className="text-sm text-rose-700">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button variant="lime" type="submit">
              Save route
            </Button>
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}
export function TransportForm({
  studentId,
  year,
  start,
  end,
  routes,
  close,
}: {
  studentId: string;
  year: string;
  start: string;
  end: string;
  routes: FeeRoute[];
  close: () => void;
}) {
  const a = useAuth(),
    qc = useQueryClient(),
    [route, setRoute] = useState(''),
    [amount, setAmount] = useState(''),
    [frequency, setFrequency] = useState<(typeof feeFrequencies)[number]>('MONTHLY'),
    [starts, setStarts] = useState(start),
    [ends, setEnds] = useState(end),
    [due, setDue] = useState(start),
    [error, setError] = useState(''),
    retry = useRef({ body: '', key: crypto.randomUUID() });
  const save = useMutation({
    mutationFn: () => {
      const body = JSON.stringify(
        transportAssignmentSchema.parse({
          student_id: studentId,
          academic_session_id: year,
          route_id: route,
          amount: Number(amount),
          frequency,
          starts_on: starts,
          ends_on: ends,
          first_due_on: due,
        }),
      );
      if (retry.current.body !== body) retry.current = { body, key: crypto.randomUUID() };
      return api('/fees/transport', {
        method: 'POST',
        headers: { 'Idempotency-Key': retry.current.key },
        body,
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [a.school] });
      close();
    },
    onError: (e: Error & { issues?: { message: string }[] }) =>
      setError(e.issues?.map((i) => i.message).join(' ') || e.message),
  });
  return (
    <Dialog
      open
      title="Assign student transport"
      description="Only this student is charged. Saving creates transport installments within the assignment dates; academic fees remain separate."
      onOpenChange={(open) => {
        if (!open && !save.isPending) close();
      }}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (window.confirm('Assign this transport service and create its fee installments?'))
            save.mutate();
        }}
      >
        <fieldset className="space-y-4" disabled={save.isPending}>
          <label className="block text-sm">
            Route / service
            <select
              className="input mt-2"
              required
              value={route}
              onChange={(e) => setRoute(e.target.value)}
            >
              <option value="">Choose an active route</option>
              {routes
                .filter((r) => r.active)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm">
              Bus fee per installment (INR)
              <input
                className="input mt-2"
                type="number"
                min="0.01"
                step="0.01"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <label className="text-sm">
              Billing frequency
              <select
                className="input mt-2"
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as typeof frequency)}
              >
                {feeFrequencies.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Service starts
              <input
                className="input mt-2"
                type="date"
                required
                value={starts}
                onChange={(e) => setStarts(e.target.value)}
              />
            </label>
            <label className="text-sm">
              Service ends
              <input
                className="input mt-2"
                type="date"
                required
                value={ends}
                onChange={(e) => setEnds(e.target.value)}
              />
            </label>
            <label className="text-sm">
              First due date
              <input
                className="input mt-2"
                type="date"
                required
                value={due}
                onChange={(e) => setDue(e.target.value)}
              />
            </label>
          </div>
          {error && (
            <p role="alert" className="text-sm text-rose-700">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="lime">
              Assign and assess transport
            </Button>
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}
export function FeeReason({
  endpoint,
  title,
  transport,
  close,
}: {
  endpoint: string;
  title: string;
  transport?: boolean;
  close: () => void;
}) {
  const a = useAuth(),
    qc = useQueryClient(),
    [reason, setReason] = useState(''),
    [date, setDate] = useState(''),
    [error, setError] = useState(''),
    key = useRef(crypto.randomUUID());
  const save = useMutation({
    mutationFn: () =>
      api(endpoint, {
        method: 'POST',
        headers: { 'Idempotency-Key': key.current },
        body: JSON.stringify({ reason, ...(transport ? { ended_on: date } : {}) }),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [a.school] });
      close();
    },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Dialog
      open
      title={title}
      description={
        transport
          ? 'Future unpaid transport installments will be voided. Paid future installments must be reversed first.'
          : 'The original record is retained. This authorized correction is added to the audit trail.'
      }
      onOpenChange={(open) => {
        if (!open && !save.isPending) close();
      }}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (window.confirm('Confirm this recorded correction?')) save.mutate();
        }}
      >
        <fieldset className="space-y-4" disabled={save.isPending}>
          {transport && (
            <label className="block text-sm">
              Last service date
              <input
                className="input mt-2"
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
          )}
          <label className="block text-sm">
            Reason
            <textarea
              className="input mt-2"
              required
              minLength={5}
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-rose-700">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button variant="lime" type="submit">
              Confirm correction
            </Button>
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}
