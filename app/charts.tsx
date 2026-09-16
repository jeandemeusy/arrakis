'use client';

import { memo } from 'react';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { formatDay, relayerColor, volume } from './chart-theme';
import { usePalette } from './style';

import type {
  ActiveUserPoint,
  ClientDetail,
  DailyUserPoint,
  Relayer,
  RelayerDayPoint,
  RelayerSeries,
  WeekPoint,
} from '@/lib/snapshot';

/**
 * The charts, each memoised on the data it draws.
 *
 * Recharts is not cheap to reconcile and there are five of these on the page.
 * Inline, their elements were rebuilt on every render of the dashboard — so
 * typing one character into a table's search box re-rendered every chart on the
 * page, none of which the search affects. Extracted and wrapped in `memo`, they
 * re-render when their own data changes and not otherwise.
 *
 * Components rather than `useMemo` on the elements deliberately: the props ARE
 * the dependency list, checked by the compiler, where a hand-written dependency
 * array would go stale silently.
 *
 * The palette comes from context rather than from props, so that switching the
 * page's visual style redraws every plot without the dashboard having to thread
 * a colour through six components — and `memo` does not stand in the way, since
 * a context change re-renders a memoised consumer regardless of its props.
 */
export const ActiveUsersChart = memo(function ActiveUsersChart({
  points,
}: {
  points: ActiveUserPoint[];
}) {
  const palette = usePalette();
  return (
    <ResponsiveContainer width="100%" height={250}>
      <ComposedChart
        data={points}
        margin={{ top: 24, right: 18, left: -18, bottom: 0 }}
      >
        <defs>
          {/* A style with no gradient still fills from this, flat top to bottom. */}
          <linearGradient id="fillMonthly" x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="0%"
              stopColor={palette.accent}
              stopOpacity={palette.areaOpacity}
            />
            <stop
              offset="100%"
              stopColor={palette.accent}
              stopOpacity={palette.areaGradient ? 0 : palette.areaOpacity}
            />
          </linearGradient>
        </defs>
        <CartesianGrid
          vertical={false}
          stroke={palette.grid}
          strokeDasharray={palette.gridDash ?? '2 5'}
        />
        <XAxis
          dataKey="date"
          axisLine={false}
          tickLine={false}
          tick={palette.axis}
          minTickGap={48}
          tickFormatter={formatDay}
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          tick={palette.axis}
          allowDecimals={false}
        />
        <Tooltip labelFormatter={formatDay} contentStyle={palette.tooltip} />
        <Area
          type="monotone"
          dataKey="monthly"
          name="Active, last 30 days"
          stroke={palette.accent}
          fill="url(#fillMonthly)"
          strokeWidth={palette.lineWidth + 1}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="weekly"
          name="Active, last 7 days"
          stroke={palette.seriesNeutral}
          strokeWidth={palette.lineWidth - 0.5}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="deployments"
          name="New clients, last 30 days"
          stroke={palette.accent2}
          strokeWidth={palette.lineWidth - 0.5}
          strokeDasharray="4 4"
          dot={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
});

export const VolumeChart = memo(function VolumeChart({
  weeks,
}: {
  weeks: WeekPoint[];
}) {
  const palette = usePalette();
  return (
    <ResponsiveContainer width="100%" height={250}>
      <ComposedChart
        data={weeks}
        margin={{ top: 20, right: 6, left: -20, bottom: 0 }}
      >
        <CartesianGrid
          vertical={false}
          stroke={palette.grid}
          strokeDasharray={palette.gridDash}
        />
        <XAxis
          dataKey="label"
          axisLine={false}
          tickLine={false}
          tick={palette.axis}
          minTickGap={24}
        />
        <YAxis
          yAxisId="left"
          axisLine={false}
          tickLine={false}
          tick={palette.axis}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          axisLine={false}
          tickLine={false}
          tick={palette.axis}
        />
        <Tooltip
          cursor={palette.cursor}
          contentStyle={palette.tooltip}
          formatter={(input: unknown) => volume(Number(input))}
        />
        <Bar
          yAxisId="left"
          dataKey="gigabytes"
          name="Upstream"
          stackId="volume"
          fill={palette.accent}
          stroke={palette.barStroke}
          strokeWidth={palette.barStrokeWidth}
        />
        <Bar
          yAxisId="left"
          dataKey="downstreamGigabytes"
          name="Downstream"
          stackId="volume"
          fill={palette.accent2}
          stroke={palette.barStroke}
          strokeWidth={palette.barStrokeWidth}
          radius={palette.barRadius}
        />
        <Line
          yAxisId="right"
          type="monotone"
          dataKey="cumulativeGigabytes"
          name="Cumulative volume"
          stroke={palette.seriesTotal}
          strokeWidth={palette.lineWidth}
          dot={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
});

export const DailyUsersChart = memo(function DailyUsersChart({
  points,
}: {
  points: DailyUserPoint[];
}) {
  const palette = usePalette();
  return (
    <ResponsiveContainer width="100%" height={250}>
      <BarChart
        data={points}
        margin={{ top: 20, right: 10, left: -24, bottom: 0 }}
      >
        <CartesianGrid
          vertical={false}
          stroke={palette.grid}
          strokeDasharray={palette.gridDash}
        />
        <XAxis
          dataKey="date"
          axisLine={false}
          tickLine={false}
          tick={palette.axis}
          minTickGap={40}
          tickFormatter={formatDay}
        />
        <YAxis
          allowDecimals={false}
          axisLine={false}
          tickLine={false}
          tick={palette.axis}
        />
        <Tooltip
          cursor={palette.cursor}
          labelFormatter={formatDay}
          contentStyle={palette.tooltip}
        />
        <Bar
          dataKey="returning"
          name="Returning"
          stackId="users"
          fill={palette.accent}
          stroke={palette.barStroke}
          strokeWidth={palette.barStrokeWidth}
        />
        <Bar
          dataKey="newClients"
          name="New"
          stackId="users"
          fill={palette.accent2}
          stroke={palette.barStroke}
          strokeWidth={palette.barStrokeWidth}
        />
      </BarChart>
    </ResponsiveContainer>
  );
});

export const RelayerShareChart = memo(function RelayerShareChart({
  slices,
}: {
  slices: Array<Relayer & { fill: string }>;
}) {
  const palette = usePalette();
  return (
    <ResponsiveContainer width="100%" height={250}>
      <PieChart>
        <Pie
          data={slices}
          dataKey="gigabytes"
          nameKey="address"
          innerRadius="55%"
          outerRadius="82%"
          paddingAngle={1}
          stroke={palette.barStroke ?? 'none'}
          strokeWidth={palette.barStrokeWidth}
          isAnimationActive={false}
        />
        <Tooltip
          contentStyle={palette.addressTooltip}
          formatter={(input: unknown, name: unknown) =>
            [volume(Number(input)), typeof name === 'string' ? name : ''] as [
              string,
              string,
            ]
          }
        />
      </PieChart>
    </ResponsiveContainer>
  );
});

export const RelayerStackChart = memo(function RelayerStackChart({
  points,
  series,
  addressOf,
}: {
  points: RelayerDayPoint[];
  series: RelayerSeries[];
  addressOf: Map<string, string>;
}) {
  const palette = usePalette();
  return (
    <ResponsiveContainer width="100%" height={250}>
      <BarChart
        data={points}
        margin={{ top: 20, right: 10, left: -18, bottom: 0 }}
      >
        <CartesianGrid
          vertical={false}
          stroke={palette.grid}
          strokeDasharray={palette.gridDash}
        />
        <XAxis
          dataKey="date"
          axisLine={false}
          tickLine={false}
          tick={palette.axis}
          minTickGap={40}
          tickFormatter={formatDay}
        />
        <YAxis axisLine={false} tickLine={false} tick={palette.axis} />
        <Tooltip
          cursor={palette.cursor}
          labelFormatter={formatDay}
          contentStyle={palette.addressTooltip}
          itemSorter={(item) => -Number(item.value ?? 0)}
          formatter={(input: unknown, name: unknown) =>
            [
              volume(Number(input)),
              typeof name === 'string' ? (addressOf.get(name) ?? name) : '',
            ] as [string, string]
          }
        />
        {series.map((entry, index) => (
          <Bar
            key={entry.key}
            dataKey={entry.key}
            stackId="relayers"
            fill={relayerColor(palette, index, series.length)}
            stroke={palette.barStroke}
            strokeWidth={palette.barStrokeWidth}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
});

/** The drill-down's own daily-volume bars. */
export const ClientDailyChart = memo(function ClientDailyChart({
  points,
}: {
  points: ClientDetail['daily'];
}) {
  const palette = usePalette();
  return (
    <ResponsiveContainer width="100%" height={170}>
      <BarChart
        data={points}
        margin={{ top: 8, right: 8, left: -22, bottom: 0 }}
      >
        <CartesianGrid
          vertical={false}
          stroke={palette.grid}
          strokeDasharray={palette.gridDash}
        />
        <XAxis
          dataKey="date"
          axisLine={false}
          tickLine={false}
          tick={palette.axis}
          minTickGap={40}
          tickFormatter={formatDay}
        />
        <YAxis axisLine={false} tickLine={false} tick={palette.axis} />
        <Tooltip
          cursor={palette.cursor}
          labelFormatter={formatDay}
          contentStyle={palette.tooltip}
          formatter={(input: unknown) => volume(Number(input))}
        />
        <Bar
          dataKey="gigabytes"
          name="Upstream"
          fill={palette.accent}
          stroke={palette.barStroke}
          strokeWidth={palette.barStrokeWidth}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  );
});
