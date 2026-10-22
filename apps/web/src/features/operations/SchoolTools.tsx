import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, useAuth } from '../../lib/auth';
import { useRows } from '../../lib/use-records';
import { Button } from '../../components/ui/button';
import { PageHeading, Panel, DataTable, Loading, ErrorState, Empty, AttendanceTabs } from '../../components/common';
import { ActionDialog } from '../../components/ActionDialog';
import RecordSelect from '../../components/RecordSelect';
import Pagination from '../../components/Pagination';
import { display } from '../../lib/utils';

export function AttendanceHistory() {
  const a = useAuth(),
    [student, setStudent] = useState(''),
    [date, setDate] = useState(''),
    [review, setReview] = useState(false),
    [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const q = useRows(
    `/attendance/events?${student ? 'student_id=' + student + '&' : ''}${date ? 'date=' + date + '&' : ''}${review ? 'review=1' : ''}`,
  );
  return (
    <>
      <PageHeading
        title="Every arrival. Every departure."
        description="A history of recorded events, within your current access."
      />
      <AttendanceTabs active="history" />
      <Panel
        title="Movement history"
        action={
          a.me?.school?.permissions.includes('attendance.correct_approve') ? (
            <label className="flex gap-2">
              <input
                type="checkbox"
                checked={review}
                onChange={(e) => setReview(e.target.checked)}
              />
              Needs review
            </label>
          ) : undefined
        }
      >
        <div className="table-toolbar flex flex-wrap gap-4">
          <div className="w-64">
            <label className="field-label" htmlFor="event-student">
              Student
            </label>
            <RecordSelect
              id="event-student"
              name="student_id"
              endpoint="/resources/students"
              value={student}
              onChange={setStudent}
              optional
              label="student"
            />
          </div>
          <div>
            <label className="field-label" htmlFor="event-date">
              Date
            </label>
            <input
              id="event-date"
              className="input"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
        </div>
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorState error={q.error} retry={() => q.refetch()} />
        ) : q.data?.data.length ? (
          <DataTable
            rows={q.data.data}
            columns={[
              'first_name',
              'student_code',
              'effective_ts',
              'device_name',
              'location_type',
              'outcome',
              'timestamp_trust',
            ]}
            actions={
              a.me?.school?.permissions.includes('attendance.correct_approve')
                ? (row) =>
                    ['QUARANTINED_TIMESTAMP', 'STORED_PENDING_RULES'].includes(
                      String(row.outcome),
                    ) ? (
                      <Button variant="outline" size="sm" onClick={() => setSelected(row)}>
                        Request reconciliation
                      </Button>
                    ) : null
                : undefined
            }
          />
        ) : (
          <Empty title="No events in this view" description="Try another student or date." />
        )}
        <Pagination
          page={q.page}
          total={q.data?.total}
          pageSize={q.data?.page_size}
          onPage={q.setPage}
        />
      </Panel>
      {a.me?.school?.permissions.includes('attendance.correct_approve') && <ReviewRequests />}
      {selected && (
        <ActionDialog
          open
          close={() => setSelected(null)}
          title="Request event reconciliation"
          endpoint={`/attendance/events/${selected.id}/reconcile`}
          fields={[{ key: 'reason', type: 'textarea' }]}
        />
      )}
    </>
  );
}
function ReviewRequests() {
  const q = useRows('/attendance/reviews');
  return (
    <Panel
      title="Reconciliation requests"
      subtitle="Raw timestamps remain unchanged. Missing clock or schedule evidence requires further information."
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : (
        <DataTable
          rows={q.data?.data || []}
          columns={['created_at', 'reason', 'status', 'result_code']}
        />
      )}
      <Pagination
        page={q.page}
        total={q.data?.total}
        pageSize={q.data?.page_size}
        onPage={q.setPage}
      />
    </Panel>
  );
}
export function FamilyProfile() {
  const a = useAuth(),
    q = useQuery({
      queryKey: [a.school, 'family-profile'],
      queryFn: () =>
        api<{ profile: Record<string, unknown> | null; children: Record<string, unknown>[] }>(
          '/profile/family',
        ),
      enabled: ['parent', 'student'].includes(a.me?.school?.role || ''),
    });
  if (!['parent', 'student'].includes(a.me?.school?.role || '')) return null;
  return (
    <Panel
      title="Your family records"
      subtitle="Your school controls the authorized links and contact records."
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : (
        <div className="settings-body">
          {q.data?.profile && (
            <dl className="grid gap-3 sm:grid-cols-3">
              {['full_name', 'email', 'phone'].map((k) => (
                <div key={k}>
                  <dt className="field-label">{k.replace('_', ' ')}</dt>
                  <dd>{display(q.data!.profile![k])}</dd>
                </div>
              ))}
            </dl>
          )}
          <DataTable
            rows={q.data?.children || []}
            columns={['student_code', 'first_name', 'last_name']}
          />
        </div>
      )}
    </Panel>
  );
}
export function AcademicOverview() {
  const a = useAuth(),
    [student, setStudent] = useState(''),
    family = ['parent', 'student'].includes(a.me?.school?.role || ''),
    q = useQuery({
      queryKey: [a.school, 'academic-overview', student],
      queryFn: () =>
        api<{ academics: Record<string, unknown>[]; attendance: Record<string, unknown>[] }>(
          '/analytics' + (student ? '?student_id=' + student : ''),
        ),
      enabled: !!a.me?.school?.permissions.includes('marks.read'),
    });
  return (
    <Panel
      title={family ? 'Learning and progress' : 'Academic performance'}
      subtitle="Published assessments only. Percentages use recorded scores and exam maxima; missing subjects are not treated as zero."
    >
      {family && (
        <div className="table-toolbar max-w-sm">
          <label className="field-label" htmlFor="progress-student">
            Student
          </label>
          <RecordSelect
            id="progress-student"
            name="student_id"
            endpoint="/resources/students"
            value={student}
            onChange={setStudent}
            optional
            label="student"
          />
        </div>
      )}
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : q.data?.academics.length ? (
        <DataTable
          rows={q.data.academics}
          columns={['grade', 'section', 'subject', 'students', 'assessments', 'percentage']}
        />
      ) : (
        <Empty title="No published assessment results yet" />
      )}
      {!!q.data?.attendance.length && (
        <DataTable rows={q.data.attendance} columns={['month', 'records', 'present', 'absent']} />
      )}
    </Panel>
  );
}
