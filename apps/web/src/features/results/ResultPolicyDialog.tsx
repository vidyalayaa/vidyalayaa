import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { resultPolicySchema, type ResultPolicy } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { ErrorState, Loading } from '../../components/common';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';

export default function ResultPolicyDialog({ close }: { close: () => void }) {
  const { school } = useAuth();
  const query = useQuery({
    queryKey: [school, 'result-policy'],
    queryFn: () => api<ResultPolicy>('/results/policy'),
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Grading policy"
      description="Use your school’s approved overall pass percentage and grade bands. Saved changes apply to existing result views."
    >
      {query.isLoading ? (
        <Loading />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => query.refetch()} />
      ) : (
        query.data && <PolicyForm policy={query.data} close={close} />
      )}
    </Dialog>
  );
}

function PolicyForm({ policy, close }: { policy: ResultPolicy; close: () => void }) {
  const { school } = useAuth();
  const client = useQueryClient();
  const [pass, setPass] = useState(policy.pass_percentage?.toString() ?? '');
  const [grades, setGrades] = useState(
    policy.grades.map((band) => ({
      id: crypto.randomUUID(),
      label: band.label,
      minimum: String(band.minimum),
    })),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    const validated = resultPolicySchema.safeParse({
      pass_percentage: pass === '' ? null : Number(pass),
      grades: grades.map(({ label, minimum }) => ({
        label,
        minimum: minimum === '' ? NaN : Number(minimum),
      })),
    });
    if (!validated.success) {
      setError(validated.error.issues[0].message);
      return;
    }
    setPending(true);
    setError('');
    try {
      await api('/results/policy', { method: 'PUT', body: JSON.stringify(validated.data) });
      await client.invalidateQueries({ queryKey: [school] });
      close();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="block text-sm">
        Overall pass percentage
        <input
          type="number"
          className="input mt-1"
          min="0"
          max="100"
          step="0.01"
          value={pass}
          onChange={(event) => setPass(event.target.value)}
          disabled={pending}
          placeholder="Unconfigured"
        />
      </label>
      <p className="text-xs text-stone-600">
        Leave blank to show results without a pass or fail classification.
      </p>
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Grade bands</h3>
        {grades.map((band, index) => (
          <div className="flex flex-wrap items-end gap-2" key={band.id}>
            <label className="min-w-24 flex-1 text-xs">
              Grade {index + 1}
              <input
                className="input mt-1"
                value={band.label}
                required
                maxLength={20}
                disabled={pending}
                onChange={(event) =>
                  setGrades(
                    grades.map((item) =>
                      item.id === band.id ? { ...item, label: event.target.value } : item,
                    ),
                  )
                }
              />
            </label>
            <label className="min-w-24 flex-1 text-xs">
              Minimum percentage {index + 1}
              <input
                className="input mt-1"
                type="number"
                value={band.minimum}
                min="0"
                max="100"
                step="0.01"
                required
                disabled={pending}
                onChange={(event) =>
                  setGrades(
                    grades.map((item) =>
                      item.id === band.id ? { ...item, minimum: event.target.value } : item,
                    ),
                  )
                }
              />
            </label>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              aria-label={`Remove grade ${index + 1}`}
              disabled={pending}
              onClick={() => setGrades(grades.filter((item) => item.id !== band.id))}
            >
              Remove
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          type="button"
          disabled={pending || grades.length >= 12}
          onClick={() =>
            setGrades([...grades, { id: crypto.randomUUID(), label: '', minimum: '' }])
          }
        >
          Add grade band
        </Button>
      </div>
      <p className="text-xs text-stone-600">If you use grade bands, start the lowest band at 0%.</p>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" type="button" disabled={pending} onClick={close}>
          Cancel
        </Button>
        <Button type="submit" variant="lime" disabled={pending}>
          {pending ? 'Saving…' : 'Save grading policy'}
        </Button>
      </div>
    </form>
  );
}
