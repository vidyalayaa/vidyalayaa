import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { AcademicGuidance, AcademicPerformance } from '@vidyalayaa/contracts';
import { api, useAuth } from '../../lib/auth';
import { ErrorState } from '../../components/common';
import { Button } from '../../components/ui/button';

const path = '/academic-intelligence';
const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const questions = [
  'Why did my marks decrease?',
  'Which subject needs more attention?',
  'Am I improving academically?',
  'What should I study before my next examination?',
];

export default function AcademicGuidancePanel({
  query,
  data,
  view,
}: {
  query: { student_id?: string; exam_id?: string };
  data: AcademicPerformance;
  view: 'analysis' | 'plan';
}) {
  const { me } = useAuth();
  const role = me?.school?.role;
  const guidance = useMutation({
    mutationFn: () =>
      api<AcademicGuidance>(`${path}/guidance`, { method: 'POST', body: JSON.stringify(query) }),
  });
  const [completed, setCompleted] = useState<number[]>([]);
  useEffect(() => {
    setCompleted(guidance.data?.completed ?? []);
  }, [guidance.data]);
  const progress = useMutation({
    mutationFn: ({ task, checked }: { task: number; checked: boolean }) =>
      api(`${path}/progress`, {
        method: 'PUT',
        body: JSON.stringify({
          plan_id: guidance.data?.plan_id,
          task,
          completed: checked,
        }),
      }),
    onSuccess: (_value, { task, checked }) =>
      setCompleted((current) =>
        checked ? [...new Set([...current, task])] : current.filter((item) => item !== task),
      ),
  });
  const replace = (value: string) =>
    value.replace(/\[S(\d+)\]/g, (match, index) => data.subjects[Number(index) - 1]?.name ?? match);
  const advice = guidance.data?.advice;
  return (
    <>
      <section className="mb-5 rounded-2xl border border-line bg-surface p-4">
        <h2 className="mb-2 font-semibold">
          {view === 'analysis' ? 'AI-generated recommendations' : 'Weekly AI study plan'}
        </h2>
        {guidance.error && <ErrorState error={guidance.error} retry={() => guidance.mutate()} />}
        {!advice && !guidance.error && (
          <Button variant="outline" disabled={guidance.isPending} onClick={() => guidance.mutate()}>
            {guidance.isPending ? 'Generating guidance…' : 'Generate AI guidance'}
          </Button>
        )}
        {advice && view === 'analysis' && (
          <div className="space-y-3 text-sm">
            <p>{replace(advice.summary)}</p>
            {advice.strengths.length > 0 && (
              <AdviceList title="Strengths" items={advice.strengths.map(replace)} />
            )}
            {advice.priorities.length > 0 && (
              <AdviceList title="Study priorities" items={advice.priorities.map(replace)} />
            )}
            <p>
              <strong>Next examination goal</strong> {replace(advice.goals.short_term)}
            </p>
            <p>
              <strong>Long-term goal</strong> {replace(advice.goals.long_term)}
            </p>
          </div>
        )}
        {advice && view === 'plan' && (
          <div className="space-y-4 text-sm">
            <p>
              <strong>Next examination goal</strong> {replace(advice.goals.short_term)}
            </p>
            <p>
              <strong>Long-term goal</strong> {replace(advice.goals.long_term)}
            </p>
            <p aria-live="polite">
              {completed.length} of {advice.tasks.length} activities complete
            </p>
            <p>
              <strong>Weekly time by subject</strong>{' '}
              {data.subjects
                .flatMap((subject, index) => {
                  const minutes = advice.tasks
                    .filter((task) => task.subject === index + 1)
                    .reduce((total, task) => total + task.minutes, 0);
                  return minutes ? [`${subject.name} ${minutes} min`] : [];
                })
                .join(' · ')}
            </p>
            <progress
              className="w-full"
              aria-label="Study plan progress"
              max={advice.tasks.length}
              value={completed.length}
            />
            {progress.error && <ErrorState error={progress.error} />}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {days.map((day, index) => {
                const tasks = advice.tasks
                  .map((task, id) => ({ task, id }))
                  .filter(({ task }) => task.day === index + 1);
                if (!tasks.length) return null;
                return (
                  <article className="rounded-xl border border-line p-3" key={day}>
                    <h3 className="mb-2 font-semibold">{day}</h3>
                    <ul className="space-y-2">
                      {tasks.map(({ task, id }) => (
                        <li key={id}>
                          <label className="flex items-start gap-2">
                            <input
                              type="checkbox"
                              checked={completed.includes(id)}
                              disabled={role !== 'student' || progress.isPending}
                              onChange={(event) =>
                                progress.mutate({ task: id, checked: event.target.checked })
                              }
                            />
                            <span>
                              <strong>
                                {data.subjects[task.subject - 1]?.name} · {task.minutes} min
                              </strong>
                              <span className="block">{replace(task.activity)}</span>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </article>
                );
              })}
            </div>
          </div>
        )}
      </section>
      {view === 'analysis' && (role === 'parent' || role === 'student') && (
        <AcademicAssistant query={query} replace={replace} />
      )}
    </>
  );
}

function AdviceList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h3 className="font-semibold">{title}</h3>
      <ul className="list-disc space-y-1 pl-5">
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function AcademicAssistant({
  query,
  replace,
}: {
  query: object;
  replace: (value: string) => string;
}) {
  const [question, setQuestion] = useState('');
  const [conversation, setConversation] = useState<{ question: string; answer: string }[]>([]);
  const assistant = useMutation({
    mutationFn: (value: string) =>
      api<{ answer: string }>(`${path}/assistant`, {
        method: 'POST',
        body: JSON.stringify({ ...query, question: value }),
      }),
    onSuccess: ({ answer }, value) => {
      setConversation((entries) => [...entries.slice(-7), { question: value, answer }]);
      setQuestion('');
    },
  });
  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <h2 className="mb-2 font-semibold">AI Academic Assistant</h2>
      <div className="mb-3 flex flex-wrap gap-2">
        {questions.map((item) => (
          <Button key={item} type="button" variant="outline" onClick={() => setQuestion(item)}>
            {item}
          </Button>
        ))}
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!assistant.isPending && question.trim().length >= 3)
            assistant.mutate(question.trim());
        }}
      >
        <label className="min-w-0 flex-1 text-sm">
          Ask about this examination
          <input
            className="input mt-1"
            value={question}
            maxLength={500}
            onChange={(event) => setQuestion(event.target.value)}
          />
        </label>
        <Button
          type="submit"
          variant="lime"
          disabled={assistant.isPending || question.trim().length < 3}
        >
          {assistant.isPending ? 'Working…' : 'Ask'}
        </Button>
      </form>
      {assistant.error && <ErrorState error={assistant.error} />}
      <ol className="mt-4 space-y-3 text-sm" aria-live="polite">
        {conversation.map((entry, index) => (
          <li key={index} className="rounded-xl border border-line p-3">
            <p className="font-semibold">{entry.question}</p>
            <p className="mt-1">{replace(entry.answer)}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
