import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { chartTheme } from '../../lib/chart-theme';
import type { ParentResultsResponse } from '@vidyalayaa/contracts';
const axis = { axisLine: false, tickLine: false, tick: { fontSize: 11, fill: chartTheme.label } };
export default function ResultCharts({
  data,
}: {
  data: Pick<ParentResultsResponse, 'subject_chart' | 'exam_chart'>;
}) {
  return (
    <div className="grid min-w-0 gap-5 lg:grid-cols-2">
      <section className="min-w-0 rounded-2xl border border-line bg-surface p-4 sm:p-5">
        <h2 className="font-semibold">Subject performance</h2>
        <p className="mt-1 text-xs text-stone-500">
          Percentage of the available marks earned in each subject
        </p>
        <div
          className="mt-5 h-72 w-full"
          role="img"
          aria-label="Published results by subject, in percent"
        >
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <BarChart
              layout="vertical"
              data={data.subject_chart}
              margin={{ left: 0, right: 10, bottom: 15 }}
            >
              <CartesianGrid horizontal={false} stroke={chartTheme.grid} strokeDasharray="4 4" />
              <XAxis {...axis} type="number" domain={[0, 100]} unit="%" />
              <YAxis
                dataKey="name"
                type="category"
                width={95}
                {...axis}
                interval={0}
                tickFormatter={(v) =>
                  String(v).length > 12 ? String(v).slice(0, 12) + '…' : String(v)
                }
              />
              <Tooltip
                {...chartTheme.tooltip}
                formatter={(value) => `${value}%`}
                cursor={{ fill: 'var(--accent-soft)' }}
              />
              <Bar
                dataKey="percentage"
                name="Result"
                fill={chartTheme.primary}
                radius={[0, 6, 6, 0]}
                maxBarSize={64}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
      <section className="min-w-0 rounded-2xl border border-line bg-surface p-4 sm:p-5">
        <h2 className="font-semibold">Examination progress</h2>
        <p className="mt-1 text-xs text-stone-500">Published examinations in date order</p>
        <div
          className="mt-5 h-72 w-full"
          role="img"
          aria-label="Published examination progress, in percent"
        >
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <LineChart data={data.exam_chart} margin={{ left: 0, right: 15, bottom: 15 }}>
              <CartesianGrid vertical={false} stroke={chartTheme.grid} strokeDasharray="4 4" />
              <XAxis
                dataKey="name"
                {...axis}
                tickFormatter={(v) =>
                  String(v).length > 14 ? String(v).slice(0, 14) + '…' : String(v)
                }
              />
              <YAxis {...axis} domain={[0, 100]} unit="%" width={45} />
              <Tooltip
                {...chartTheme.tooltip}
                formatter={(value) => `${value}%`}
                cursor={{ stroke: chartTheme.grid }}
              />
              <Line
                type="monotone"
                dataKey="percentage"
                name="Result"
                stroke={chartTheme.primary}
                strokeWidth={3}
                dot={{ r: 5, fill: chartTheme.primary, stroke: chartTheme.primary }}
                activeDot={{ r: 6 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  );
}
