import { useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { nfcCardSerialSchema, type Page } from '@vidyalayaa/contracts';
import { Empty, Panel } from '../../components/common';
import RecordSelect, { recordLabel } from '../../components/RecordSelect';
import { Button } from '../../components/ui/button';
import { api, useAuth } from '../../lib/auth';
import { IssueCardDialog } from './CardActionDialogs';
import { useNfcReader } from './use-nfc-reader';

type RosterStudent = { id: string; has_active_card: boolean } & Record<string, unknown>;
type Context = { schoolId: string; userId: string; resolvedSchoolId: string };
type Assignment = { student_id: string; card_serial: string; card_uid: string; key: string };

export default function CardIssuance() {
  const auth = useAuth();
  const userId = auth.me?.id;
  const resolvedSchoolId = auth.me?.school?.school_id;
  if (!userId || !resolvedSchoolId)
    return (
      <Empty title="Card issuance unavailable" description="Select a school to issue cards." />
    );

  return (
    <IssuanceDesk
      key={`${userId}:${resolvedSchoolId}:${auth.requestSchool}`}
      context={{ userId, schoolId: auth.requestSchool, resolvedSchoolId }}
    />
  );
}

function IssuanceDesk({ context }: { context: Context }) {
  const auth = useAuth(),
    qc = useQueryClient(),
    device = useNfcReader();
  const [mode, setMode] = useState<'student' | 'class'>('student');
  const [student, setStudent] = useState('');
  const [classId, setClassId] = useState('');
  const [classStudent, setClassStudent] = useState('');
  const [serial, setSerial] = useState('');
  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [scanTarget, setScanTarget] = useState('');
  const [phase, setPhase] = useState<'idle' | 'arming' | 'scan' | 'save'>('idle');
  const [issued, setIssued] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [manual, setManual] = useState(false);
  const serialField = useRef<HTMLInputElement>(null);
  const busy = phase !== 'idle';
  const roster = useQuery({
    queryKey: [auth.school, 'nfc-issuance-roster', classId],
    enabled: mode === 'class' && !!classId,
    queryFn: async ({ signal }) => {
      const records: RosterStudent[] = [];
      for (let page = 1; ; page++) {
        const result = await api<Page<RosterStudent>>(
          `/student-directory/students?class_id=${classId}&include_nfc_card=1&page_size=100&page=${page}`,
          { signal, headers: { 'X-School-Id': context.resolvedSchoolId } },
          true,
          'json',
          context,
        );
        records.push(...result.data);
        if (page * result.page_size >= result.total) return records;
      }
    },
  });
  const remaining = roster.data?.filter((row) => !row.has_active_card && !issued[row.id]) || [];
  const target =
    assignment?.student_id ||
    scanTarget ||
    (mode === 'student'
      ? student
      : (remaining.find((row) => row.id === classStudent) || remaining[0])?.id || '');
  const selectedOutsideQueue =
    target && !remaining.some((row) => row.id === target)
      ? roster.data?.find((row) => row.id === target)
      : undefined;

  function clearCard() {
    setAssignment(null);
    setSerial('');
    setError('');
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !target || issued[target]) return;
    const printed = nfcCardSerialSchema.safeParse(serial);
    if (!printed.success) return;
    setError('');
    setMessage('');
    try {
      let card = assignment;
      if (!card) {
        setScanTarget(target);
        setPhase('arming');
        card = {
          student_id: target,
          card_serial: printed.data,
          card_uid: await device.scan(() => setPhase('scan')),
          key: crypto.randomUUID(),
        };
        setAssignment(card);
      }
      setPhase('save');
      const { key, ...body } = card;
      await api(
        '/cards/issue',
        {
          method: 'POST',
          headers: { 'Idempotency-Key': key, 'X-School-Id': context.resolvedSchoolId },
          body: JSON.stringify({ ...body, replace_existing: false }),
        },
        true,
        'json',
        context,
      );
      setIssued((cards) => ({ ...cards, [body.student_id]: body.card_serial }));
      setMessage(`Card ${body.card_serial} issued successfully.`);
      clearCard();
      setClassStudent('');
      void qc.invalidateQueries({ queryKey: [auth.school] });
      requestAnimationFrame(() => serialField.current?.focus());
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not issue the card.');
    } finally {
      setScanTarget('');
      setPhase('idle');
    }
  }

  return (
    <section aria-labelledby="nfc-issue-heading" className="mb-6">
      <h2 id="nfc-issue-heading" className="mb-3 text-base font-semibold text-ink">
        Issue card to student
      </h2>
      <div className="card-issuance-grid grid max-w-5xl items-start gap-5 lg:grid-cols-2">
        <Panel title="Select students" className="min-w-0">
          <fieldset disabled={busy || !!assignment} className="card-issuance-panel-body space-y-4">
            <legend className="sr-only">Issue cards for</legend>
            <div className="flex flex-wrap gap-x-5">
              <label className="inline-flex min-h-11 items-center gap-2 text-sm font-medium">
                <input
                  type="radio"
                  name="issue-mode"
                  checked={mode === 'student'}
                  onChange={() => {
                    setMode('student');
                    clearCard();
                  }}
                />
                One student
              </label>
              <label className="inline-flex min-h-11 items-center gap-2 text-sm font-medium">
                <input
                  type="radio"
                  name="issue-mode"
                  checked={mode === 'class'}
                  onChange={() => {
                    setMode('class');
                    clearCard();
                  }}
                />
                A class or section
              </label>
            </div>
            {mode === 'student' ? (
              <div>
                <label className="field-label" htmlFor="issue-student">
                  Student
                </label>
                <RecordSelect
                  name="issue-student"
                  endpoint="/resources/students"
                  label="student"
                  value={student}
                  onChange={(id) => {
                    setStudent(id);
                    clearCard();
                  }}
                />
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="field-label" htmlFor="issue-class">
                    Class or section
                  </label>
                  <RecordSelect
                    name="issue-class"
                    endpoint="/student-directory/enrollment-classes"
                    label="class"
                    value={classId}
                    onChange={(id) => {
                      setClassId(id);
                      setClassStudent('');
                      clearCard();
                    }}
                  />
                </div>
                {roster.isLoading && <p role="status">Loading class roster…</p>}
                {roster.error && (
                  <p role="alert" className="field-error">
                    {roster.error.message}
                  </p>
                )}
                {roster.data && (
                  <div>
                    <label className="field-label" htmlFor="issue-class-student">
                      Next student
                    </label>
                    <select
                      className="input"
                      id="issue-class-student"
                      value={target}
                      disabled={!remaining.length}
                      onChange={(event) => {
                        setClassStudent(event.target.value);
                        clearCard();
                      }}
                    >
                      {selectedOutsideQueue && (
                        <option value={target}>{recordLabel(selectedOutsideQueue)}</option>
                      )}
                      {!target && <option value="">No students awaiting a card</option>}
                      {remaining.map((row) => (
                        <option key={row.id} value={row.id}>
                          {recordLabel(row)}
                        </option>
                      ))}
                    </select>
                    <p className="mt-2 text-sm text-muted">
                      {remaining.length} of {roster.data.length} students awaiting a card
                    </p>
                  </div>
                )}
              </div>
            )}
          </fieldset>
        </Panel>
        <Panel title="Read and issue" className="min-w-0">
          <div className="card-issuance-panel-body">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-muted p-3">
              <div>
                <p className="text-sm font-medium">USB reader</p>
                <p className="mt-1 text-xs text-muted" role="status">
                  {device.status === 'connected'
                    ? 'Connected'
                    : device.status === 'connecting'
                      ? 'Connecting…'
                      : 'Disconnected'}
                </p>
              </div>
              {device.supported ? (
                <Button
                  variant="outline"
                  disabled={busy || device.status === 'connecting'}
                  onClick={() =>
                    void (device.status === 'connected' ? device.disconnect() : device.connect())
                  }
                >
                  {device.status === 'connected'
                    ? 'Disconnect USB reader'
                    : device.status === 'connecting'
                      ? 'Opening USB port…'
                      : 'Connect USB reader'}
                </Button>
              ) : (
                <p className="text-sm text-muted">
                  Open this page in desktop Chrome or Edge over HTTPS or localhost to connect the
                  reader.
                </p>
              )}
            </div>
            {device.error && (
              <p className="field-error mt-2" role="alert">
                {device.error}
              </p>
            )}
            <form onSubmit={save} className="mt-5 space-y-4">
              <div>
                <label className="field-label" htmlFor="printed-card-serial">
                  Printed card serial number
                </label>
                <input
                  id="printed-card-serial"
                  className="input"
                  ref={serialField}
                  value={serial}
                  maxLength={64}
                  onChange={(event) => setSerial(event.target.value)}
                  disabled={!target || !!issued[target] || busy || !!assignment}
                  aria-describedby="printed-serial-hint"
                  required
                />
                <p id="printed-serial-hint" className="mt-2 text-sm text-muted">
                  {serial.trim() && !nfcCardSerialSchema.safeParse(serial).success
                    ? 'Start with a letter or number. Use letters, numbers, hyphens, underscores, periods or slashes.'
                    : 'Enter the number printed on the card, then tap that same card.'}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="lime"
                  type="submit"
                  disabled={
                    busy ||
                    !target ||
                    !!issued[target] ||
                    !nfcCardSerialSchema.safeParse(serial).success ||
                    (!assignment && device.status !== 'connected')
                  }
                >
                  {assignment ? 'Retry saving card' : 'Arm reader'}
                </Button>
                {assignment && !busy && (
                  <Button variant="outline" type="button" onClick={clearCard}>
                    Clear scan
                  </Button>
                )}
                {mode === 'student' && !assignment && (
                  <Button
                    variant="outline"
                    type="button"
                    disabled={busy}
                    onClick={() => setManual(true)}
                  >
                    Enter UID manually
                  </Button>
                )}
              </div>
              <p role="status" className="text-sm empty:hidden">
                {phase === 'arming'
                  ? 'Remove any card from the reader.'
                  : phase === 'scan'
                    ? 'Tap the card on the USB reader now.'
                    : phase === 'save'
                      ? 'Saving card…'
                      : message}
              </p>
              {error && (
                <p className="field-error" role="alert">
                  {error}
                </p>
              )}
            </form>
          </div>
        </Panel>
      </div>
      {manual && (
        <IssueCardDialog
          open
          close={() => setManual(false)}
          initialStudentId={student || undefined}
        />
      )}
    </section>
  );
}
