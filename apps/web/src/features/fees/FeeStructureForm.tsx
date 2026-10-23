import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  feeStructureSchema,
  feeCategories,
  feeFrequencies,
  type FeeStructureInput,
} from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { Dialog } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
export interface FeeClass {
  id: string;
  grade: string;
  section: string;
  academic_session_id: string;
}
export interface FeeStructure {
  id: string;
  mode: 'SAME' | 'SECTION';
  version: number;
  items: (FeeStructureInput['items'][number] & { id: string })[];
  class_ids: string[];
  created_at: string;
}
export default function FeeStructureForm({
  year,
  grade,
  classes,
  latest,
  start,
  close,
}: {
  year: string;
  grade: string;
  classes: FeeClass[];
  latest?: FeeStructure;
  start: string;
  close: () => void;
}) {
  const a = useAuth(),
    qc = useQueryClient(),
    [mode, setMode] = useState<'SAME' | 'SECTION'>(latest?.mode || 'SAME'),
    [items, setItems] = useState<FeeStructureInput['items']>(
      latest?.items.map(({ class_id, category, label, amount, frequency, first_due_on }) => ({
        class_id,
        category,
        label,
        amount: Number(amount),
        frequency,
        first_due_on: first_due_on.slice(0, 10),
      })) || [],
    ),
    [error, setError] = useState(''),
    retry = useRef({ body: '', key: crypto.randomUUID() });
  const save = useMutation({
    mutationFn: () => {
      const body = JSON.stringify(
        feeStructureSchema.parse({
          academic_session_id: year,
          grade,
          mode,
          expected_version: latest?.version || 0,
          items,
        }),
      );
      if (retry.current.body !== body) retry.current = { body, key: crypto.randomUUID() };
      return api('/fees/structures', {
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': retry.current.key },
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [a.school] });
      close();
    },
    onError: (e: Error & { issues?: { message: string }[] }) =>
      setError(e.issues?.map((i) => i.message).join(' ') || e.message),
  });
  const groups = mode === 'SAME' ? [{ id: null, section: 'All existing sections' }] : classes;
  const update = (index: number, key: string, value: unknown) =>
    setItems(items.map((item, n) => (n === index ? { ...item, [key]: value } : item)));
  return (
    <Dialog
      open
      title={`Class ${grade} fee structure`}
      description="Amounts are per installment. Saving creates a new version; existing student assessments and receipts stay unchanged."
      onOpenChange={(open) => {
        if (!open && !save.isPending && window.confirm('Discard this fee structure draft?'))
          close();
      }}
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          save.mutate();
        }}
      >
        <fieldset disabled={save.isPending} className="min-w-0 space-y-5">
          <label className="block text-sm">
            Section fee configuration
            <select
              className="input mt-2"
              value={mode}
              onChange={(e) => {
                if (
                  items.length &&
                  !window.confirm('Switch section mode and clear draft fee items?')
                )
                  return;
                setMode(e.target.value as typeof mode);
                setItems([]);
              }}
            >
              <option value="SAME">Same fee for all sections</option>
              <option value="SECTION">Different fees by section</option>
            </select>
          </label>
          {groups.map((group) => (
            <section
              key={group.id || 'all'}
              className="space-y-3 rounded-xl border border-stone-200 p-4"
            >
              <h3 className="font-semibold">
                {mode === 'SAME' ? 'All sections' : `Section ${group.section}`}
              </h3>
              {items.map((item, index) =>
                item.class_id === group.id ? (
                  <div key={index} className="space-y-3 border-t border-stone-100 pt-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="text-sm">
                        Category
                        <select
                          className="input mt-1"
                          value={item.category}
                          onChange={(e) => update(index, 'category', e.target.value)}
                        >
                          {feeCategories.map((c) => (
                            <option key={c}>{c}</option>
                          ))}
                        </select>
                      </label>
                      <label className="text-sm">
                        Fee label
                        <input
                          className="input mt-1"
                          required
                          maxLength={100}
                          value={item.label}
                          onChange={(e) => update(index, 'label', e.target.value)}
                        />
                      </label>
                      <label className="text-sm">
                        Amount per installment (INR)
                        <input
                          className="input mt-1"
                          type="number"
                          min="0.01"
                          step="0.01"
                          required
                          value={item.amount || ''}
                          onChange={(e) => update(index, 'amount', Number(e.target.value))}
                        />
                      </label>
                      <label className="text-sm">
                        Schedule
                        <select
                          className="input mt-1"
                          value={item.frequency}
                          onChange={(e) => update(index, 'frequency', e.target.value)}
                        >
                          {feeFrequencies.map((f) => (
                            <option key={f}>{f}</option>
                          ))}
                        </select>
                      </label>
                      <label className="text-sm">
                        First due date
                        <input
                          className="input mt-1"
                          type="date"
                          required
                          value={item.first_due_on}
                          onChange={(e) => update(index, 'first_due_on', e.target.value)}
                        />
                      </label>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setItems(items.filter((_, n) => n !== index))}
                    >
                      Remove fee item
                    </Button>
                  </div>
                ) : null,
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  setItems([
                    ...items,
                    {
                      class_id: group.id,
                      category: 'TUITION',
                      label: 'Tuition',
                      amount: 0,
                      frequency: 'MONTHLY',
                      first_due_on: start,
                    },
                  ])
                }
              >
                Add fee category
              </Button>
            </section>
          ))}
          <p className="text-xs text-stone-500">
            Transport is billed separately only for students with a transport assignment. Recurring
            fees continue through the academic year, using the same day each month or the last day
            of shorter months.
          </p>
          {error && (
            <p role="alert" className="text-sm text-rose-700">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="lime" disabled={!items.length || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save new version'}
            </Button>
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}
