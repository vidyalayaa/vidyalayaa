import type {
  ParentAttendanceDay,
  ParentAttendanceSummary,
  ParentResultRecord,
  ParentResultsResponse,
  ParentResultChartPoint,
} from '@vidyalayaa/contracts';
export function attendanceSummary(days: ParentAttendanceDay[]): ParentAttendanceSummary {
  const count = (status: string) =>
    days.filter((d) => d.school_day && d.attendance_status === status).length;
  const finalized = days.filter(
    (d) => d.school_day && !['PENDING', 'NOT_RECORDED'].includes(d.attendance_status),
  ).length;
  const present = count('PRESENT') + count('LATE') + count('HALF_DAY');
  return {
    school_days: days.filter((d) => d.school_day).length,
    present_days: present,
    absent_days: count('ABSENT'),
    late_days: count('LATE'),
    half_days: count('HALF_DAY'),
    excused_days: count('EXCUSED'),
    pending_days: count('PENDING'),
    unrecorded_days: count('NOT_RECORDED'),
    finalized_days: finalized,
    attendance_percentage: finalized ? Math.round((present / finalized) * 1000) / 10 : null,
  };
}
export function resultCharts(
  data: ParentResultRecord[],
): Pick<ParentResultsResponse, 'subject_chart' | 'exam_chart' | 'summary'> {
  const group = (kind: 'subject' | 'exam') => {
    const map = new Map<string, ParentResultChartPoint>();
    for (const row of data) {
      const id = kind === 'subject' ? row.subject_id : row.exam_id;
      const entry = map.get(id) || {
        id,
        name: kind === 'subject' ? row.subject : row.examination,
        score: 0,
        maximum: 0,
        count: 0,
        percentage: 0,
        date: kind === 'exam' ? row.exam_date || row.result_date : undefined,
      };
      entry.score = Math.round((entry.score + Number(row.score)) * 100) / 100;
      entry.maximum = Math.round((entry.maximum + Number(row.max_score)) * 100) / 100;
      entry.count++;
      map.set(id, entry);
    }
    return [...map.values()]
      .map((x) => ({ ...x, percentage: Math.round((x.score / x.maximum) * 1000) / 10 }))
      .sort((a, b) =>
        kind === 'subject'
          ? a.name.localeCompare(b.name)
          : (a.date || '').localeCompare(b.date || '') ||
            a.name.localeCompare(b.name) ||
            a.id.localeCompare(b.id),
      );
  };
  const score = data.reduce((s, r) => s + Math.round(Number(r.score) * 100), 0) / 100,
    maximum = data.reduce((s, r) => s + Math.round(Number(r.max_score) * 100), 0) / 100;
  return {
    subject_chart: group('subject'),
    exam_chart: group('exam'),
    summary: {
      score,
      maximum,
      percentage: maximum ? Math.round((score / maximum) * 1000) / 10 : null,
      examinations: new Set(data.map((r) => r.exam_id)).size,
    },
  };
}
