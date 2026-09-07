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

import {
  ADDRESS_TOOLTIP,
  AXIS,
  CURSOR,
  GRID,
  INK,
  INTEGER,
  PLUM,
  TOOLTIP,
  YELLOW,
  formatDay,
  relayerColor,
  volume,
} from './chart-theme';

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
 */
export const ActiveUsersChart = memo(function ActiveUsersChart({
  points,
}: {
  points: ActiveUserPoint[];
}) {
  return (
    <ResponsiveContainer width="100%" height={250}>
      <ComposedChart
        data={points}
        margin={{ top: 24, right: 18, left: -18, bottom: 0 }}
      >
        <defs>
          <linearGradient id="fillMonthly" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={YELLOW} stopOpacity={0.45} />
            <stop offset="100%" stopColor={YELLOW} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke={GRID} strokeDasharray="2 5" />
        <XAxis
          dataKey="date"
          axisLine={false}
          tickLine={false}
          tick={AXIS}
          minTickGap={48}
          tickFormatter={formatDay}
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          tick={AXIS}
          allowDecimals={false}
        />
        <Tooltip labelFormatter={formatDay} contentStyle={TOOLTIP} />
        <Area
          type="monotone"
          dataKey="monthly"
          name="Active, last 30 days"
          stroke={YELLOW}
          fill="url(#fillMonthly)"
          strokeWidth={3}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="weekly"
          name="Active, last 7 days"
          stroke="#9b978d"
          strokeWidth={1.5}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="deployments"
          name="New clients, last 30 days"
          stroke={PLUM}
          strokeWidth={1.5}
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
  return (
    <ResponsiveContainer width="100%" height={250}>
      <ComposedChart
        data={weeks}
        margin={{ top: 20, right: 6, left: -20, bottom: 0 }}
      >
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis
          dataKey="label"
          axisLine={false}
          tickLine={false}
          tick={AXIS}
          minTickGap={24}
        />
        <YAxis yAxisId="left" axisLine={false} tickLine={false} tick={AXIS} />
        <YAxis
          yAxisId="right"
          orientation="right"
          axisLine={false}
          tickLine={false}
          tick={AXIS}
        />
        <Tooltip
          cursor={CURSOR}
          contentStyle={TOOLTIP}
          formatter={(input: unknown) => volume(Number(input))}
        />
        <Bar
          yAxisId="left"
          dataKey="gigabytes"
          name="Upstream"
          stackId="volume"
          fill={YELLOW}
        />
        <Bar
          yAxisId="left"
          dataKey="downstreamGigabytes"
          name="Downstream"
          stackId="volume"
          fill={PLUM}
          radius={[2, 2, 0, 0]}
        />
        <Line
          yAxisId="right"
          type="monotone"
          dataKey="cumulativeGigabytes"
          name="Cumulative volume"
          stroke={INK}
          strokeWidth={2}
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
  return (
    <ResponsiveContainer width="100%" height={250}>
      <BarChart
        data={points}
        margin={{ top: 20, right: 10, left: -24, bottom: 0 }}
      >
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis
          dataKey="date"
          axisLine={false}
          tickLine={false}
          tick={AXIS}
          minTickGap={40}
          tickFormatter={formatDay}
        />
        <YAxis
          allowDecimals={false}
          axisLine={false}
          tickLine={false}
          tick={AXIS}
        />
        <Tooltip
          cursor={CURSOR}
          labelFormatter={formatDay}
          contentStyle={TOOLTIP}
        />
        <Bar
          dataKey="returning"
          name="Returning"
          stackId="users"
          fill={YELLOW}
        />
        <Bar dataKey="newClients" name="New" stackId="users" fill={PLUM} />
      </BarChart>
    </ResponsiveContainer>
  );
});

export const RelayerShareChart = memo(function RelayerShareChart({
  slices,
}: {
  slices: Array<Relayer & { fill: string }>;
}) {
  return (
    <ResponsiveContainer width="100%" height={250}>
      <PieChart>
        <Pie
          data={slices}
          dataKey="redemptions"
          nameKey="address"
          innerRadius="55%"
          outerRadius="82%"
          paddingAngle={1}
          stroke="none"
          isAnimationActive={false}
        />
        <Tooltip
          contentStyle={ADDRESS_TOOLTIP}
          formatter={(input: unknown, name: unknown) =>
            [
              `${INTEGER.format(Number(input))} redemptions`,
              typeof name === 'string' ? name : '',
            ] as [string, string]
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
  return (
    <ResponsiveContainer width="100%" height={250}>
      <BarChart
        data={points}
        margin={{ top: 20, right: 10, left: -18, bottom: 0 }}
      >
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis
          dataKey="date"
          axisLine={false}
          tickLine={false}
          tick={AXIS}
          minTickGap={40}
          tickFormatter={formatDay}
        />
        <YAxis axisLine={false} tickLine={false} tick={AXIS} />
        <Tooltip
          cursor={CURSOR}
          labelFormatter={formatDay}
          contentStyle={ADDRESS_TOOLTIP}
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
            fill={relayerColor(index, series.length)}
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
  return (
    <ResponsiveContainer width="100%" height={170}>
      <BarChart
        data={points}
        margin={{ top: 8, right: 8, left: -22, bottom: 0 }}
      >
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis
          dataKey="date"
          axisLine={false}
          tickLine={false}
          tick={AXIS}
          minTickGap={40}
          tickFormatter={formatDay}
        />
        <YAxis axisLine={false} tickLine={false} tick={AXIS} />
        <Tooltip
          cursor={CURSOR}
          labelFormatter={formatDay}
          contentStyle={TOOLTIP}
          formatter={(input: unknown) => volume(Number(input))}
        />
        <Bar
          dataKey="gigabytes"
          name="Upstream"
          fill={YELLOW}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  );
});
