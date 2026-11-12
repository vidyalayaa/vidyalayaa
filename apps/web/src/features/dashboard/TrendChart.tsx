import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { chartTheme } from '../../lib/chart-theme';
export default function TrendChart({
  data,
}: {
  data: { date: string; present: number; total: number }[];
}) {
  return (
    <div className="p-4">
      <div className="h-60" role="img" aria-label="Attendance totals over the last seven days">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} barGap={4}>
            <CartesianGrid vertical={false} stroke={chartTheme.grid} strokeDasharray="4 4" />
            <XAxis
              dataKey="date"
              axisLine={false}
              tickLine={false}
              tickFormatter={(d) =>
                new Date(`${d}T12:00:00`).toLocaleDateString('en', { weekday: 'short' })
              }
              tick={{ fontSize: 12, fill: chartTheme.label }}
            />
            <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: chartTheme.label }} />
            <Tooltip {...chartTheme.tooltip} cursor={{ fill: 'var(--surface-hover)' }} />
            <Bar
              dataKey="present"
              name="Present"
              fill={chartTheme.primary}
              radius={[5, 5, 0, 0]}
              maxBarSize={22}
            />
            <Bar
              dataKey="total"
              name="Enrolled records"
              fill={chartTheme.secondary}
              radius={[5, 5, 0, 0]}
              maxBarSize={22}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <details className="mt-3 text-xs text-stone-500">
        <summary className="cursor-pointer">View data table</summary>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Present</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.date}>
                <td>{d.date}</td>
                <td>{d.present}</td>
                <td>{d.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
