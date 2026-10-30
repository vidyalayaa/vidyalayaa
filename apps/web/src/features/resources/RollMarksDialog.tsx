import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, useAuth } from '../../lib/auth';
import { useMarksEntrySheet } from '../../lib/use-marks-entry-sheet';
import { useUnsavedChanges } from '../../lib/use-unsaved-changes';
import { Dialog } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { Loading, ErrorState, Empty } from '../../components/common';
import {
  MarksSaveQueue,
  type MarksQueueSnapshot,
  type QueuedMark,
} from '../../lib/marks-save-queue';
import { scopedDraft } from '../../lib/drafts';
import { marksRequestContext } from '../../lib/marks-request-context';

export default function RollMarksDialog({ examId, close }: { examId: string; close: () => void }) {
  const a = useAuth(),
    qc = useQueryClient(),
    sheet = useMarksEntrySheet(examId),
    [subject, setSubject] = useState(''),
    [index, setIndex] = useState(0),
    [score, setScore] = useState(''),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState(''),
    [complete, setComplete] = useState(false),
    [saves, setSaves] = useState<MarksQueueSnapshot>({ jobs: [], confirmed: 0 }),
    scoreInput = useRef<HTMLInputElement>(null),
    advancing = useRef(false),
    queue = useRef<MarksSaveQueue | null>(null);
  const owner = a.session?.user.id || a.me?.id || '',
    school = a.school,
    draftKey = `${owner}:${school}:roll-marks:${examId}`;
  useEffect(() => {
    const draft = scopedDraft(draftKey),
      restored = draft.read().jobs;
    const worker = new MarksSaveQueue(
      async (job, signal) => {
        if (!draft.isCurrent())
          throw new Error('Your account or school changed. Reopen marks entry before continuing.');
        await api(
          '/marks/entry',
          {
            method: 'POST',
            signal,
            headers: { 'Idempotency-Key': job.key },
            body: JSON.stringify({
              exam_id: examId,
              entries: [
                {
                  student_id: job.studentId,
                  subject_id: job.subjectId,
                  score: job.score,
                  remarks: job.remarks,
                },
              ],
            }),
          },
          true,
          'json',
          marksRequestContext(
            a.me,
            owner,
            school,
            sessionStorage.getItem('vidyalayaa.school') || '',
          ),
        );
        qc.setQueryData<NonNullable<typeof sheet.data>>(
          [school, 'marks-entry-sheet', examId],
          (old) =>
            old
              ? {
                  ...old,
                  marks: [
                    ...old.marks.filter(
                      (m) => m.student_id !== job.studentId || m.subject_id !== job.subjectId,
                    ),
                    {
                      student_id: job.studentId,
                      subject_id: job.subjectId,
                      score: job.score,
                      remarks: job.remarks,
                    },
                  ],
                }
              : old,
        );
      },
      (snapshot) => {
        if (snapshot.jobs.length) draft.save({ jobs: snapshot.jobs });
        else draft.clear();
      },
      Array.isArray(restored) ? (restored as QueuedMark[]) : [],
    );
    queue.current = worker;
    const unsubscribe = worker.subscribe(setSaves);
    return () => {
      unsubscribe();
      worker.dispose();
      if (queue.current === worker) queue.current = null;
    };
  }, [owner, school, examId, draftKey, qc]);
  const data = sheet.data,
    selectedSubject =
      data?.subjects.find((s) => s.id === subject)?.id || data?.subjects[0]?.id || '',
    student = data?.students[index];
  useUnsavedChanges(dirty || saves.jobs.length > 0);
  useEffect(() => {
    const queued = queue.current
      ?.snapshot()
      .jobs.filter((job) => job.studentId === student?.id && job.subjectId === selectedSubject)
      .at(-1);
    const mark = data?.marks.find(
      (m) => m.student_id === student?.id && m.subject_id === selectedSubject,
    );
    setScore(queued ? String(queued.score) : mark ? String(mark.score) : '');
    setDirty(false);
    setError('');
    advancing.current = false;
    const frame = requestAnimationFrame(() => {
      if (!complete) {
        scoreInput.current?.focus();
        scoreInput.current?.select();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [student?.id, selectedSubject, complete, draftKey]);
  const discard = () => !dirty || window.confirm('Discard the unsaved score for this student?');
  const requestClose = () => {
    const pending = queue.current?.snapshot().jobs.length || 0;
    if (
      pending &&
      !window.confirm(
        `${pending} mark save${pending === 1 ? ' is' : 's are'} not confirmed yet. Close and keep the pending entries as a draft in this tab? Reopen marks entry to retry. Refreshing or signing out can discard this draft.`,
      )
    )
      return;
    if (!discard()) return;
    qc.invalidateQueries({ queryKey: [a.school] });
    close();
  };
  return (
    <Dialog
      open
      title="Enter marks by roll number"
      description="Enter a score and press Enter to open the next student instantly. Marks save in order in the background; keep this page open until all saves are confirmed."
      onOpenChange={(v) => {
        if (!v) requestClose();
      }}
    >
      {sheet.isLoading ? (
        <Loading />
      ) : sheet.error ? (
        <ErrorState error={sheet.error} retry={() => sheet.refetch()} />
      ) : !data?.subjects.length ? (
        <Empty title="No subjects configured for this examination" />
      ) : !data.students.length ? (
        <Empty title="No enrolled students in this class" />
      ) : (
        <form
          className="space-y-5"
          noValidate
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.repeat) e.preventDefault();
          }}
          onSubmit={(e) => {
            e.preventDefault();
            if (advancing.current || !student || complete) return;
            const value = Number(score);
            if (
              !score.trim() ||
              !Number.isFinite(value) ||
              value < 0 ||
              value > data.exam.max_score
            ) {
              setError(
                `Enter a score from 0 to ${data.exam.max_score}. Leave unrecorded marks blank and use Skip student.`,
              );
              scoreInput.current?.focus();
              return;
            }
            setError('');
            if (!queue.current) {
              setError('Wait for marks entry to finish loading.');
              return;
            }
            advancing.current = true;
            const previous = data.marks.find(
              (m) => m.student_id === student.id && m.subject_id === selectedSubject,
            );
            queue.current.enqueue({
              studentId: student.id,
              subjectId: selectedSubject,
              score: value,
              remarks: previous?.remarks ?? null,
              label: `${student.roll_number ? 'Roll ' + student.roll_number : student.student_code} · ${data.subjects.find((s) => s.id === selectedSubject)?.name || 'Subject'}`,
            });
            setDirty(false);
            setScore('');
            if (index + 1 < data.students.length) setIndex(index + 1);
            else setComplete(true);
          }}
        >
          <p className="text-sm text-stone-600">
            Class {data.classroom.grade} · Section {data.classroom.section} · {data.exam.name} ·
            Maximum {data.exam.max_score}
          </p>
          <label className="field-label block">
            Subject
            <select
              className="input mt-2"
              value={selectedSubject}
              onChange={(e) => {
                if (!discard()) return;
                setSubject(e.target.value);
                setIndex(0);
                setComplete(false);
              }}
            >
              {data.subjects.map((s) => (
                <option value={s.id} key={s.id}>
                  {s.name} · {s.code}
                </option>
              ))}
            </select>
          </label>
          {complete ? (
            <div className="rounded-xl border border-lime-500 bg-lime-500/10 p-5" role="status">
              <h3 className="font-semibold">End of this class roster</h3>
              <p className="mt-2 text-sm">
                {saves.confirmed} score saves confirmed · {saves.jobs.length} not confirmed yet.
                Skipped students were not changed.
              </p>
              <Button
                className="mt-3"
                type="button"
                variant="outline"
                onClick={() => {
                  setIndex(0);
                  setComplete(false);
                }}
              >
                Review students again
              </Button>
            </div>
          ) : (
            <>
              <label className="field-label block">
                Student by roll number
                <select
                  className="input mt-2"
                  value={index}
                  onChange={(e) => {
                    if (discard()) setIndex(Number(e.target.value));
                  }}
                >
                  {data.students.map((s, i) => (
                    <option value={i} key={s.id}>
                      {s.roll_number ? 'Roll ' + s.roll_number : 'No roll number'} · {s.first_name}{' '}
                      {s.last_name || ''} · {s.student_code}
                    </option>
                  ))}
                </select>
              </label>
              <div className="rounded-xl border border-stone-200 bg-stone-50 p-5">
                <p className="text-xs text-stone-600">
                  Student {index + 1} of {data.students.length}
                </p>
                <h3 className="mt-2 font-semibold">
                  {student?.first_name} {student?.last_name}
                </h3>
                <p className="text-sm text-stone-600">
                  Roll number: {student?.roll_number || 'Not recorded'} · Student code:{' '}
                  {student?.student_code}
                </p>
                <label className="field-label mt-4 block" htmlFor="roll-score">
                  Score (maximum {data.exam.max_score})
                </label>
                <input
                  ref={scoreInput}
                  id="roll-score"
                  className="input mt-2 text-lg"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={data.exam.max_score}
                  step="0.01"
                  value={score}
                  onChange={(e) => {
                    setScore(e.target.value);
                    setDirty(true);
                    setError('');
                  }}
                  aria-describedby="roll-score-help"
                />
                <p id="roll-score-help" className="mt-2 text-xs text-stone-600">
                  Enter queues this score and opens the next student instantly. Zero is a valid
                  score. Skip leaves existing records unchanged.
                </p>
              </div>
            </>
          )}
          <div
            className="rounded-xl border border-stone-200 bg-stone-50 p-3"
            aria-label="Marks save status"
          >
            <p role="status" className="text-sm" aria-live="polite">
              {saves.jobs.length
                ? `${saves.confirmed} saved · ${saves.jobs.length} pending`
                : dirty
                  ? `${saves.confirmed} saved · current score not submitted.`
                  : saves.confirmed
                    ? 'All entered marks saved.'
                    : 'Scores save in the background after you press Enter.'}
            </p>
            {!!saves.jobs.length && (
              <p className="mt-1 text-xs text-stone-600">
                Keep this page open. Pending entries are retained only in this tab until refresh or
                sign-out.
              </p>
            )}
            {saves.jobs.some((job) => job.status === 'failed') && (
              <div role="alert" className="field-error mt-2">
                <p>Some saves are not confirmed. Your scores are retained.</p>
                <ul className="mt-1 list-disc pl-4">
                  {saves.jobs
                    .filter((job) => job.status === 'failed')
                    .slice(0, 5)
                    .map((job) => (
                      <li key={job.key}>
                        {job.label}: {job.error}
                      </li>
                    ))}
                </ul>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-2"
                  onClick={() => queue.current?.retry()}
                >
                  Retry pending saves
                </Button>
              </div>
            )}
          </div>
          {error && (
            <p role="alert" className="field-error">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={requestClose}>
              Close
            </Button>
            {!complete && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    if (!discard()) return;
                    setDirty(false);
                    if (index + 1 < data.students.length) setIndex((n) => n + 1);
                    else setComplete(true);
                  }}
                >
                  Skip student
                </Button>
                <Button type="submit" variant="lime">
                  Save & next student
                </Button>
              </>
            )}
          </div>
        </form>
      )}
    </Dialog>
  );
}
