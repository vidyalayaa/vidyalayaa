import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  platformDailyNotificationSchema,
  platformNotificationSchema,
  type Page,
  type PlatformDailyNotification,
  type PlatformNotification,
} from '@vidyalayaa/contracts';
import { api } from '../../lib/auth';
import { display, fromDateTimeLocal } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { DataTable, ErrorState, Loading, PageHeading, Panel } from '../../components/common';
import Pagination from '../../components/Pagination';

type SchoolOption = {
  id: string;
  name: string;
  school_code: string;
  timezone: string;
  status: string;
  subscription_status: string;
};
const notificationPath = '/platform/notifications';
const historyKey = ['platform', 'notifications'];
const dailyKey = [...historyKey, 'daily'];
type Delivery = 'now' | 'schedule' | 'daily';

export default function PlatformNotifications() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [school, setSchool] = useState<SchoolOption>();
  const [delivery, setDelivery] = useState<Delivery>('now');
  const [page, setPage] = useState(1);
  const [dailyPage, setDailyPage] = useState(1);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [cancel, setCancel] = useState<{
    id: string;
    title: string;
    school_name: string;
    daily: boolean;
  }>();
  const previous = useRef<{ body: string; key: string } | undefined>(undefined);

  const schools = useQuery({
    queryKey: ['platform', 'notification-schools', search.trim()],
    queryFn: () =>
      api<Page<SchoolOption>>(
        '/platform/schools?page_size=100&search=' + encodeURIComponent(search.trim()),
      ),
  });
  const options = (schools.data?.data || []).filter(
    (item) =>
      item.status === 'ACTIVE' &&
      ['TRIALING', 'ACTIVE', 'PAST_DUE'].includes(item.subscription_status),
  );
  if (school && !options.some((item) => item.id === school.id)) options.unshift(school);

  const history = useQuery({
    queryKey: [...historyKey, page],
    queryFn: () => api<Page<PlatformNotification>>(notificationPath + '?page=' + page),
    refetchInterval: 30_000,
  });
  const dailySchedules = useQuery({
    queryKey: [...dailyKey, dailyPage],
    queryFn: () =>
      api<Page<PlatformDailyNotification>>(notificationPath + '/daily?page=' + dailyPage),
    refetchInterval: 30_000,
  });
  const send = useMutation({
    mutationFn: ({ body, key, daily }: { body: string; key: string; daily: boolean }) =>
      api(notificationPath + (daily ? '/daily' : ''), {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body,
      }),
  });
  const cancellation = useMutation({
    mutationFn: ({ id, daily }: { id: string; daily: boolean }) =>
      api(notificationPath + (daily ? '/daily/' : '/') + id + '/cancel', { method: 'POST' }),
    onSuccess: (_, { daily }) => {
      setCancel(undefined);
      setNotice(daily ? 'Daily schedule stopped.' : 'Notification cancelled.');
      void qc.invalidateQueries({ queryKey: historyKey });
    },
  });
  function confirmCancel(row: Record<string, unknown>, daily: boolean) {
    cancellation.reset();
    setCancel({
      id: String(row.id),
      title: String(row.title),
      school_name: String(row.school_name),
      daily,
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!school || send.isPending) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    setError('');
    setNotice('');
    try {
      const when =
        delivery === 'schedule'
          ? fromDateTimeLocal(String(fields.get('when')), school.timezone)
          : null;
      const details = {
        school_id: school.id,
        title: fields.get('title'),
        body: fields.get('message'),
      };
      const daily = delivery === 'daily';
      const localTime = String(fields.get('when'));
      const input = daily
        ? platformDailyNotificationSchema.parse({ ...details, local_time: localTime })
        : platformNotificationSchema.parse({ ...details, scheduled_at: when });
      const body = JSON.stringify(input);
      if (previous.current?.body !== body) previous.current = { body, key: crypto.randomUUID() };
      await send.mutateAsync({ ...previous.current, daily });
      previous.current = undefined;
      form.reset();
      setDelivery('now');
      if (daily) setDailyPage(1);
      else setPage(1);
      setNotice(
        daily
          ? `Scheduled daily at ${localTime} (${school.timezone}).`
          : when
            ? `Scheduled for ${display(when, school.timezone)} (${school.timezone}).`
            : 'Notification queued for sending.',
      );
      await qc.invalidateQueries({ queryKey: historyKey });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <PageHeading
        eyebrow="VIDYALAYAA PLATFORM"
        title="School notifications"
        description="Send or schedule a push notification for active members of one school."
      />
      <Panel title="Compose a notification">
        <form className="settings-body space-y-4" onSubmit={submit}>
          <fieldset className="space-y-4" disabled={send.isPending}>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="field-label block">
                Find a school
                <input
                  className="input mt-2"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="School name or code"
                  maxLength={200}
                />
              </label>
              <label className="field-label block">
                Recipient school
                <select
                  className="input mt-2"
                  required
                  value={school?.id || ''}
                  onChange={(e) => setSchool(options.find((item) => item.id === e.target.value))}
                >
                  <option value="">
                    {schools.isLoading ? 'Loading schools…' : 'Choose a school'}
                  </option>
                  {options.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.name} · {item.school_code}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {schools.error && (
              <ErrorState error={schools.error} retry={() => void schools.refetch()} />
            )}
            {schools.isSuccess && !options.length && (
              <p className="text-sm text-stone-600">No eligible schools match this search.</p>
            )}
            <label className="field-label block">
              Notification title
              <input className="input mt-2" name="title" maxLength={120} required />
            </label>
            <label className="field-label block">
              Message
              <textarea className="input mt-2 min-h-24" name="message" maxLength={1000} required />
            </label>
            <label className="field-label block">
              Delivery
              <select
                className="input mt-2"
                aria-label="Delivery"
                value={delivery}
                onChange={(e) => setDelivery(e.target.value as Delivery)}
              >
                <option value="now">Send now</option>
                <option value="schedule">Schedule for later</option>
                <option value="daily">Send daily</option>
              </select>
            </label>
            {delivery !== 'now' && (
              <label className="field-label block">
                {delivery === 'daily' ? 'Daily send time' : 'Send date and time'}
                <input
                  key={school?.id + ':' + delivery}
                  className="input mt-2"
                  type={delivery === 'daily' ? 'time' : 'datetime-local'}
                  name="when"
                  required
                />
                <span className="mt-2 block text-xs text-stone-600">
                  {school
                    ? `Time zone for ${school.name}: ${school.timezone}`
                    : 'Choose a school to see its time zone.'}
                </span>
              </label>
            )}
            {delivery === 'daily' && (
              <p className="text-sm text-stone-600">
                Repeats every day, including weekends, until you stop the schedule.
              </p>
            )}
            <p className="text-sm text-stone-600">
              Push delivery follows the school’s notification settings and requires members to have
              notifications enabled on their devices.
            </p>
          </fieldset>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="notice" role="status">
              {notice}
            </p>
          )}
          <Button variant="lime" disabled={!school || send.isPending}>
            {send.isPending
              ? 'Saving…'
              : {
                  now: 'Send notification',
                  schedule: 'Schedule notification',
                  daily: 'Create daily schedule',
                }[delivery]}
          </Button>
        </form>
      </Panel>
      <Panel
        title="Daily schedules"
        subtitle="See the next send time or stop future daily messages."
      >
        {dailySchedules.isLoading ? (
          <Loading />
        ) : dailySchedules.error ? (
          <ErrorState error={dailySchedules.error} retry={() => void dailySchedules.refetch()} />
        ) : dailySchedules.data?.data.length ? (
          <DataTable
            rows={dailySchedules.data.data.map((item) => ({
              ...item,
              daily_at: item.local_time + ' (' + item.timezone + ')',
              next_send:
                item.status === 'ACTIVE' && item.next_run_at
                  ? display(item.next_run_at, item.timezone)
                  : '—',
            }))}
            columns={['school_name', 'title', 'daily_at', 'next_send', 'status']}
            actions={(row) =>
              row.status !== 'CANCELLED' && (
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => confirmCancel(row, true)}
                >
                  Stop daily schedule
                </Button>
              )
            }
          />
        ) : (
          <p className="p-5 text-sm text-stone-600">No daily schedules have been created.</p>
        )}
        <Pagination
          total={dailySchedules.data?.total}
          page={dailyPage}
          pageSize={dailySchedules.data?.page_size}
          onPage={setDailyPage}
        />
      </Panel>
      <Panel
        title="Scheduled and sent notifications"
        subtitle="Review scheduled messages and cancel any message the worker hasn’t started."
      >
        {history.isLoading ? (
          <Loading />
        ) : history.error ? (
          <ErrorState error={history.error} retry={() => void history.refetch()} />
        ) : history.data?.data.length ? (
          <DataTable
            rows={history.data.data.map((item) => ({
              ...item,
              send_time: item.scheduled_at
                ? display(item.scheduled_at, item.timezone) + ' (' + item.timezone + ')'
                : 'Send now',
            }))}
            columns={[
              'school_name',
              'title',
              'send_time',
              'status',
              'recipients',
              'sent',
              'failed',
            ]}
            actions={(row) =>
              ['SCHEDULED', 'QUEUED'].includes(String(row.status)) && (
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => confirmCancel(row, false)}
                >
                  Cancel notification
                </Button>
              )
            }
          />
        ) : (
          <p className="p-5 text-sm text-stone-600">No platform notifications have been created.</p>
        )}
        <Pagination
          total={history.data?.total}
          page={page}
          pageSize={history.data?.page_size}
          onPage={setPage}
        />
      </Panel>
      {cancel && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !cancellation.isPending) setCancel(undefined);
          }}
          title={cancel.daily ? 'Stop this daily schedule?' : 'Cancel this notification?'}
          description={
            cancel.title +
            ' · ' +
            cancel.school_name +
            (cancel.daily ? '. Messages already queued may still be delivered.' : '')
          }
        >
          {cancellation.error && (
            <p className="field-error" role="alert">
              {cancellation.error.message}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={cancellation.isPending}
              onClick={() => setCancel(undefined)}
            >
              {cancel.daily ? 'Keep schedule' : 'Keep notification'}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={cancellation.isPending}
              onClick={() => cancellation.mutate(cancel)}
            >
              {cancellation.isPending
                ? 'Saving…'
                : cancel.daily
                  ? 'Confirm stop'
                  : 'Confirm cancellation'}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
