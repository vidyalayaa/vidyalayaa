import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import type {
  OperationsAnswer,
  OperationsTopic,
  operationsQuestionSchema,
  Role,
} from '@vidyalayaa/contracts';
import type { z } from 'zod';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { ErrorState } from '../../components/common';
import { api, HttpError } from '../../lib/auth';
import { schoolPath } from '../../lib/portals';

const topics: Record<OperationsTopic, { question: string; action: string; path: string }> = {
  attendance: {
    question: 'Which classes haven’t submitted attendance today?',
    action: 'Open attendance',
    path: '/attendance',
  },
  fees: {
    question: 'Which fee payments are overdue this month?',
    action: 'Open fees',
    path: '/r/fee_records',
  },
  corrections: {
    question: 'Which attendance corrections need review?',
    action: 'Open corrections',
    path: '/corrections',
  },
  devices: {
    question: 'Which RFID devices are offline?',
    action: 'Open NFC devices',
    path: '/devices',
  },
  timetable: {
    question: 'Which classes have no lecture right now?',
    action: 'Open timetable',
    path: '/r/timetable_entries',
  },
};

export default function AskVidyalayaa({
  role,
  permitted,
  context,
}: {
  role: Role;
  permitted: OperationsTopic[];
  context: { userId: string; schoolId: string };
}) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const request = useMutation({
    mutationFn: (body: z.infer<typeof operationsQuestionSchema>) =>
      api<OperationsAnswer>(
        '/operations-assistant',
        { method: 'POST', body: JSON.stringify(body) },
        true,
        'json',
        context,
      ),
  });
  const unavailable =
    request.error instanceof HttpError &&
    (request.error.code === 'UNSUPPORTED_OPERATIONS_QUESTION' ||
      request.error.code === 'FORBIDDEN');
  return (
    <Dialog
      size="compact"
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) {
          request.reset();
          setQuestion('');
        }
      }}
      title="Ask Vidyalayaa"
      description="Check school operations using the records available to your role."
      trigger={
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Ask Vidyalayaa"
          title="Ask Vidyalayaa"
          className="shrink-0"
        >
          <Sparkles size={16} aria-hidden="true" />
          <span className="hidden lg:inline">Ask Vidyalayaa</span>
        </Button>
      }
    >
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={request.isPending}
          onClick={() => request.mutate({ kind: 'brief' })}
        >
          Daily operations brief
        </Button>
        {permitted.map((topic) => (
          <Button
            type="button"
            key={topic}
            variant="outline"
            size="sm"
            disabled={request.isPending}
            onClick={() => {
              setQuestion(topics[topic].question);
              request.mutate({ kind: 'question', question: topics[topic].question, topic });
            }}
          >
            {topics[topic].question}
          </Button>
        ))}
      </div>
      <form
        className="mt-4 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (question.trim().length >= 3 && !request.isPending)
            request.mutate({ kind: 'question', question });
        }}
      >
        <label className="min-w-0 flex-1 text-sm">
          Your question
          <input
            maxLength={240}
            className="input mt-1"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
          />
        </label>
        <Button
          variant="lime"
          type="submit"
          disabled={request.isPending || question.trim().length < 3}
        >
          Ask
        </Button>
      </form>
      <div aria-live="polite" className="mt-4 space-y-3">
        {request.isPending && <p className="text-sm">Checking school records…</p>}
        {request.error &&
          (unavailable ? (
            <p className="rounded-xl border border-line p-3 text-sm" role="status">
              {request.error.message}
            </p>
          ) : (
            <ErrorState error={request.error} />
          ))}
        {request.data && (
          <>
            {request.data.summary && (
              <div className="rounded-xl border border-line p-3 text-sm">
                <h3 className="font-semibold">AI suggested priorities</h3>
                <p className="mt-1 break-words">{request.data.summary}</p>
              </div>
            )}
            <div className="space-y-2 text-sm">
              <h3 className="font-semibold">School records · {request.data.date}</h3>
              {request.data.notes.map(({ topic, text, details }) => (
                <div key={topic} className="rounded-xl border border-line p-3">
                  <p>{text}</p>
                  {Boolean(details?.length) && (
                    <ul className="mt-2 list-disc space-y-1 pl-5">
                      {details?.map((detail, index) => (
                        <li className="break-words" key={index}>
                          {detail}
                        </li>
                      ))}
                    </ul>
                  )}
                  <Link
                    className="mt-2 inline-block font-semibold underline"
                    to={schoolPath(topics[topic].path, role)}
                    onClick={() => {
                      request.reset();
                      setOpen(false);
                      setQuestion('');
                    }}
                  >
                    {topics[topic].action}
                  </Link>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
