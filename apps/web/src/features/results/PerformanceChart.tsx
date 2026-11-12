import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { chartTheme } from '../../lib/chart-theme';

export default function PerformanceChart({
  title,
  points,
  metric = 'percentage',
  trend = false,
}: {
  title: string;
  points: { name: string; percentage?: number | null; count?: number; marks?: number | null }[];
  metric?: 'percentage' | 'count' | 'marks';
  trend?: boolean;
}) {
  const data = points.filter((point) => point[metric] != null);
  if (!data.length)
    return <p className="py-8 text-sm text-stone-600">No recorded scores in this selection.</p>;
  const suffix = metric === 'percentage' ? '%' : '';
  const axes = (
    <>
      <CartesianGrid vertical={false} stroke={chartTheme.grid} strokeDasharray="4 4" />
      <XAxis
        dataKey="name"
        stroke={chartTheme.grid}
        tick={{ fontSize: 11, fill: chartTheme.label }}
        tickFormatter={(value: string) => (value.length > 15 ? value.slice(0, 14) + '…' : value)}
      />
      <YAxis
        width={42}
        stroke={chartTheme.grid}
        domain={metric === 'percentage' ? [0, 100] : [0, 'auto']}
        unit={suffix}
        allowDecimals={false}
        tick={{ fontSize: 11, fill: chartTheme.label }}
      />
      <Tooltip
        {...chartTheme.tooltip}
        formatter={(value) => `${value}${suffix}`}
        cursor={trend ? { stroke: chartTheme.grid } : { fill: 'var(--surface-hover)' }}
      />
    </>
  );
  return (
    <figure className="min-w-0">
      <div className="h-60 w-full" role="img" aria-label={title}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          {trend ? (
            <LineChart data={data} margin={{ top: 12, right: 12, bottom: 8, left: 0 }}>
              {axes}
              <Line
                dataKey={metric}
                name="Average"
                stroke={chartTheme.primary}
                strokeWidth={3}
                dot={{ fill: chartTheme.primary, r: 4 }}
                isAnimationActive={false}
              />
            </LineChart>
          ) : (
            <BarChart data={data} margin={{ top: 12, right: 12, bottom: 8, left: 0 }}>
              {axes}
              <Bar
                dataKey={metric}
                name={
                  metric === 'count'
                    ? 'Students'
                    : metric === 'marks'
                      ? 'Average marks'
                      : 'Percentage'
                }
                fill={chartTheme.primary}
                radius={[5, 5, 0, 0]}
                maxBarSize={55}
                isAnimationActive={false}
              />
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
      <ul aria-label={title + ' values'} className="sr-only">
        {data.map((point, index) => (
          <li key={index}>
            {point.name} {point[metric]}
            {suffix}
          </li>
        ))}
      </ul>
    </figure>
  );
}
