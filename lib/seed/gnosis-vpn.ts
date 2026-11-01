import type { VisualizationConfig, VisualizationType } from '../viz/config';
import type { Builder, BuilderFilter } from '../viz/builder';
import type { Step } from '../viz/transform';

/**
 * The Gnosis VPN dashboard, as saved queries, charts and layout.
 *
 * This is the page that used to be computed in lib/snapshot.ts, rebuilt from
 * the same parts anyone can use in the studio: the SQL lives in
 * db/seed/gnosis-vpn/*.sql, and every chart below is an ordinary
 * visualization over one query's stored result. Installing it (Dashboards →
 * Install, or `npm run parity`) writes all of it into the application
 * database; from then on it is edited in the studio like anything else.
 * Installing again updates what it created and leaves everything else alone.
 */

export type SeedQuery = {
  slug: string;
  title: string;
  description: string;
  kind: 'query' | 'fragment';
  /** Seconds between scheduled refreshes; queries only. */
  refreshSeconds?: number;
  /** `hidden` for figures that only mean something per network. */
  combine?: 'concat' | 'hidden';
};

export type SeedVisualization = {
  /** Stable across installs; stored as the visualization's seed_key. */
  key: string;
  query: string;
  title: string;
  type: VisualizationType;
  config: VisualizationConfig;
};

export type SeedWidget =
  | {
      kind: 'visualization';
      visualization: string;
      /** Columns of the 12-column grid, 1 to 12. */
      width: number;
      height: number;
      options?: {
        note?: string;
        requires?: string;
        link?: { column: string; var: string; dashboard?: string };
      };
    }
  | { kind: 'text'; text: string; note?: string };

export type SeedDashboard = {
  slug: string;
  title: string;
  description: string;
  visibility: 'private' | 'unlisted' | 'public';
  variables: Array<Record<string, unknown>>;
  widgets: SeedWidget[];
};

export type Seed = {
  name: string;
  title: string;
  queries: SeedQuery[];
  visualizations: SeedVisualization[];
  dashboards: SeedDashboard[];
};

// The filters and windows the charts share.
const upstream: BuilderFilter = {
  column: 'direction',
  operator: '=',
  value: { literal: 'upstream' },
};
const chosenDirection: BuilderFilter = {
  column: 'direction',
  operator: '=',
  value: { var: 'direction' },
};
const ofClient = (column: string): BuilderFilter => ({
  column,
  operator: '=',
  value: { var: 'client' },
});
const inRange = (column = 'day') => ({ column });

/** A chart made with the simple editor: the steps are compiled on install. */
function built(
  builder: Builder,
  options: VisualizationConfig['options'] = {},
): VisualizationConfig {
  return { steps: [], encoding: {}, options, builder };
}

function config(
  steps: Step[],
  encoding: VisualizationConfig['encoding'],
  options: VisualizationConfig['options'] = {},
): VisualizationConfig {
  return { steps, encoding, options };
}

function sql(
  text: string,
  encoding: VisualizationConfig['encoding'],
  options: VisualizationConfig['options'] = {},
): VisualizationConfig {
  return { steps: [], encoding, options, sql: text.trim() };
}

const visualizations: SeedVisualization[] = [
  // Headline figures.
  {
    key: 'gnosis-vpn/monthly-active-users',
    query: 'client-activity',
    title: 'Monthly active users',
    type: 'number',
    config: built({
      window: { column: 'day', fixed: '31d' },
      measures: [
        { fn: 'count_distinct', columns: ['network', 'client'], as: 'users' },
      ],
    }),
  },
  {
    key: 'gnosis-vpn/data-relayed',
    query: 'vpn-traffic',
    title: 'Data relayed',
    type: 'number',
    config: built({
      window: inRange(),
      measures: [
        {
          fn: 'sum',
          columns: ['gigabytes'],
          as: 'gigabytes',
          format: 'gigabytes',
        },
      ],
    }),
  },
  {
    key: 'gnosis-vpn/redemptions',
    query: 'vpn-traffic',
    title: 'Redemptions',
    type: 'number',
    config: built({
      filters: [upstream],
      window: inRange(),
      measures: [{ fn: 'count', as: 'redemptions' }],
    }),
  },
  {
    key: 'gnosis-vpn/new-clients',
    query: 'client-deployments',
    title: 'New clients',
    type: 'number',
    config: built({
      window: inRange('deployed_on'),
      measures: [{ fn: 'count', as: 'clients' }],
    }),
  },
  {
    // Steps, not the simple editor: the balance is converted from wei.
    key: 'gnosis-vpn/active-channels',
    query: 'network-state',
    title: 'Active channels',
    type: 'number',
    config: config(
      [
        {
          op: 'aggregate',
          groupBy: [],
          measures: [
            { fn: 'sum', columns: ['open_channels'], as: 'channels' },
            { fn: 'sum', columns: ['channel_balance'], as: 'wei' },
          ],
        },
        {
          op: 'compute',
          as: 'allocated',
          left: 'wei',
          operator: '/',
          right: { literal: 1e18 },
        },
      ],
      { y: ['channels'], note: 'allocated' },
      { caption: 'wxHOPR allocated', formats: { allocated: 'compact' } },
    ),
  },

  // Users and traffic.
  {
    key: 'gnosis-vpn/active-users',
    query: 'client-activity',
    title: 'Monthly active users',
    type: 'area',
    config: built({
      window: { column: 'day', from: '2026-01-01' },
      groups: [{ column: 'day' }],
      rolling: 31,
      measures: [
        { fn: 'count_distinct', columns: ['network', 'client'], as: 'monthly' },
      ],
    }),
  },
  {
    key: 'gnosis-vpn/volume',
    query: 'vpn-traffic',
    title: 'Data volume',
    type: 'bar',
    config: built(
      {
        window: inRange(),
        groups: [{ column: 'day', unit: 'auto', as: 'period' }],
        // Upstream first, in the first colour, as the page has always drawn it.
        split: { column: 'direction', order: 'za' },
        measures: [
          {
            fn: 'sum',
            columns: ['gigabytes'],
            as: 'gigabytes',
            format: 'gigabytes',
          },
        ],
      },
      { stacked: true },
    ),
  },
  {
    key: 'gnosis-vpn/downstream-ratio',
    query: 'vpn-traffic',
    title: 'Downstream per upstream',
    type: 'number',
    config: sql(
      `
SELECT SUM(gigabytes) FILTER (WHERE direction = 'downstream')
       / NULLIF(SUM(gigabytes) FILTER (WHERE direction = 'upstream'), 0) AS ratio
FROM {{result}}`,
      { y: ['ratio'] },
      { format: 'decimal', caption: '× upstream, all time' },
    ),
  },
  {
    key: 'gnosis-vpn/exits-seen',
    query: 'vpn-traffic',
    title: 'Exits seen',
    type: 'number',
    config: built(
      {
        filters: [
          {
            column: 'direction',
            operator: '=',
            value: { literal: 'downstream' },
          },
        ],
        measures: [
          { fn: 'count_distinct', columns: ['network', 'payer'], as: 'exits' },
        ],
      },
      { caption: 'configured exits seen paying a relay' },
    ),
  },
  {
    key: 'gnosis-vpn/direction-agreement',
    query: 'vpn-traffic',
    title: 'Upstream and downstream agree',
    type: 'number',
    config: sql(
      `
-- One minus half the total variation between the two directions' shares of
-- volume by weekday and hour: 1 when the grids match, 0 when they share no hour.
WITH cell AS (
  SELECT direction,
         EXTRACT(isodow FROM redeemed_at) AS weekday,
         EXTRACT(hour FROM redeemed_at) AS hour,
         SUM(gigabytes) AS gigabytes
  FROM {{result}}
  GROUP BY 1, 2, 3
),
share AS (
  SELECT direction, weekday, hour,
         gigabytes / NULLIF(SUM(gigabytes) OVER (PARTITION BY direction), 0) AS share
  FROM cell
),
up AS (SELECT * FROM share WHERE direction = 'upstream' AND share IS NOT NULL),
down AS (SELECT * FROM share WHERE direction = 'downstream' AND share IS NOT NULL)
SELECT CASE
         WHEN EXISTS (SELECT 1 FROM up) AND EXISTS (SELECT 1 FROM down)
           THEN 1 - SUM(ABS(COALESCE(up.share, 0) - COALESCE(down.share, 0))) / 2
       END AS agreement
FROM up FULL JOIN down ON up.weekday = down.weekday AND up.hour = down.hour`,
      { y: ['agreement'] },
      { format: 'percent', caption: 'of the hour-of-week pattern, all time' },
    ),
  },

  // Daily activity.
  {
    key: 'gnosis-vpn/daily-users',
    query: 'client-activity',
    title: 'Daily users',
    type: 'bar',
    config: built(
      {
        window: inRange(),
        groups: [{ column: 'day' }],
        split: { column: 'kind', order: 'za' },
        measures: [
          {
            fn: 'count_distinct',
            columns: ['network', 'client'],
            as: 'clients',
          },
        ],
      },
      { stacked: true },
    ),
  },
  {
    key: 'gnosis-vpn/retention',
    query: 'client-activity',
    title: 'Cohort retention',
    type: 'cohort',
    config: sql(
      `
-- Clients grouped by the month they were deployed (from January 2026), and for
-- each month since, the share of the group a relay redeemed tickets for.
WITH member AS (
  SELECT DISTINCT network, client, DATE_TRUNC('month', deployed_on)::date AS cohort
  FROM {{result}}
  WHERE deployed_on >= DATE '2026-01-01'
),
size AS (
  SELECT cohort, COUNT(*) AS clients FROM member GROUP BY cohort
),
active AS (
  SELECT DISTINCT network, client, DATE_TRUNC('month', day)::date AS month
  FROM {{result}}
  WHERE redemptions > 0
),
grid AS (
  SELECT size.cohort, size.clients, offset_month
  FROM size,
       generate_series(
         0,
         ((EXTRACT(year FROM CURRENT_DATE) - EXTRACT(year FROM size.cohort)) * 12
           + EXTRACT(month FROM CURRENT_DATE) - EXTRACT(month FROM size.cohort))::integer
       ) AS offset_month
)
SELECT TO_CHAR(grid.cohort, 'YYYY-MM') || ' · ' || grid.clients AS cohort,
       grid.offset_month AS month,
       COUNT(active.client)::float8 / grid.clients AS share
FROM grid
JOIN member ON member.cohort = grid.cohort
LEFT JOIN active
  ON active.network = member.network
 AND active.client = member.client
 AND active.month = (grid.cohort + MAKE_INTERVAL(months => grid.offset_month))::date
GROUP BY grid.cohort, grid.clients, grid.offset_month
ORDER BY grid.cohort, grid.offset_month`,
      { row: 'cohort', x: 'month', value: 'share' },
      { format: 'percent' },
    ),
  },
  {
    key: 'gnosis-vpn/hours',
    query: 'vpn-traffic',
    title: 'When VPN is used',
    type: 'heatmap',
    config: built({
      filters: [chosenDirection],
      window: inRange(),
      groups: [
        { column: 'redeemed_at', unit: 'hour_of_day', as: 'hour' },
        { column: 'redeemed_at', unit: 'day_of_week', as: 'weekday' },
      ],
      measures: [{ fn: 'sum', columns: ['gigabytes'], as: 'gigabytes' }],
      share: { of: 'gigabytes' },
    }),
  },

  // Relayers.
  {
    key: 'gnosis-vpn/relayer-share',
    query: 'vpn-traffic',
    title: 'Relayer concentration',
    type: 'share',
    config: built({
      filters: [upstream],
      window: inRange(),
      groups: [{ column: 'relay' }],
      measures: [
        {
          fn: 'sum',
          columns: ['gigabytes'],
          as: 'gigabytes',
          format: 'gigabytes',
        },
      ],
      top: { n: 20, others: 'Other relayers' },
    }),
  },
  {
    key: 'gnosis-vpn/relayer-daily',
    query: 'vpn-traffic',
    title: 'Estimated daily volume per relayer',
    type: 'bar',
    config: built(
      {
        filters: [chosenDirection],
        window: inRange(),
        groups: [{ column: 'day' }],
        split: { column: 'relay' },
        measures: [
          {
            fn: 'sum',
            columns: ['gigabytes'],
            as: 'gigabytes',
            format: 'gigabytes',
          },
        ],
      },
      { stacked: true },
    ),
  },

  // Ticket parameters: one row each, read as it is.
  {
    key: 'gnosis-vpn/winning-probability',
    query: 'ticket-parameters',
    title: 'Winning probability',
    type: 'number',
    config: config([], { y: ['win_probability'] }, { format: 'decimal' }),
  },
  {
    key: 'gnosis-vpn/ticket-price',
    query: 'ticket-parameters',
    title: 'Ticket price',
    type: 'number',
    config: config(
      [],
      { y: ['ticket_price'] },
      { format: 'token', caption: 'wxHOPR' },
    ),
  },
  {
    key: 'gnosis-vpn/ticket-value',
    query: 'ticket-parameters',
    title: 'Ticket value',
    type: 'number',
    config: config(
      [],
      { y: ['ticket_value'] },
      { format: 'token', caption: 'wxHOPR' },
    ),
  },

  // Clients.
  {
    key: 'gnosis-vpn/top-clients',
    query: 'vpn-traffic',
    title: 'Most active users',
    type: 'table',
    config: built({
      filters: [upstream],
      window: inRange(),
      groups: [{ column: 'network' }, { column: 'payer' }],
      measures: [
        { fn: 'count', as: 'redemptions' },
        {
          fn: 'sum',
          columns: ['gigabytes'],
          as: 'gigabytes',
          label: 'upstream',
          format: 'gigabytes',
        },
      ],
      having: [{ column: 'gigabytes', operator: '>', value: { literal: 0 } }],
      rank: { by: 'gigabytes' },
    }),
  },
  {
    key: 'gnosis-vpn/deployments',
    query: 'client-deployments',
    title: 'Client deployments',
    type: 'table',
    config: built(
      { sort: [{ column: 'deployed_at', desc: true }] },
      {
        columns: ['deployed_at', 'client'],
        labels: { deployed_at: 'deployed' },
      },
    ),
  },
  {
    key: 'gnosis-vpn/feed',
    query: 'recent-redemptions',
    title: 'Redemption feed',
    type: 'table',
    config: built(
      {
        sort: [
          { column: 'redeemed_at', desc: true },
          { column: 'block', desc: true },
        ],
        limit: 500,
      },
      {
        columns: ['redeemed_at', 'client', 'relay', 'channel'],
        labels: { redeemed_at: 'redeemed' },
      },
    ),
  },
  {
    key: 'gnosis-vpn/contracts',
    query: 'indexed-contracts',
    title: 'Indexed contracts',
    type: 'table',
    config: built(
      { sort: [{ column: 'role' }, { column: 'network' }] },
      { columns: ['role', 'network', 'contract'], pageSize: 20 },
    ),
  },

  // One client's record.
  {
    key: 'gnosis-vpn-client/redemptions',
    query: 'vpn-traffic',
    title: 'Redemptions',
    type: 'number',
    config: built(
      {
        filters: [upstream, ofClient('payer')],
        measures: [
          { fn: 'count', as: 'redemptions' },
          { fn: 'sum', columns: ['tickets'], as: 'tickets', format: 'number' },
        ],
      },
      { caption: 'tickets' },
    ),
  },
  {
    key: 'gnosis-vpn-client/volume',
    query: 'vpn-traffic',
    title: 'Upstream volume',
    type: 'number',
    config: built({
      filters: [upstream, ofClient('payer')],
      measures: [
        {
          fn: 'sum',
          columns: ['gigabytes'],
          as: 'gigabytes',
          format: 'gigabytes',
        },
      ],
    }),
  },
  {
    key: 'gnosis-vpn-client/active-days',
    query: 'vpn-traffic',
    title: 'Active days',
    type: 'number',
    config: built({
      filters: [upstream, ofClient('payer')],
      measures: [{ fn: 'count_distinct', columns: ['day'], as: 'days' }],
    }),
  },
  {
    key: 'gnosis-vpn-client/deployed',
    query: 'client-deployments',
    title: 'Deployed',
    type: 'number',
    config: built({
      filters: [ofClient('client')],
      measures: [{ fn: 'min', columns: ['deployed_at'], as: 'deployed_at' }],
    }),
  },
  {
    key: 'gnosis-vpn-client/first-seen',
    query: 'vpn-traffic',
    title: 'First seen',
    type: 'number',
    config: built({
      filters: [upstream, ofClient('payer')],
      measures: [{ fn: 'min', columns: ['redeemed_at'], as: 'redeemed_at' }],
    }),
  },
  {
    key: 'gnosis-vpn-client/last-seen',
    query: 'vpn-traffic',
    title: 'Last seen',
    type: 'number',
    config: built({
      filters: [upstream, ofClient('payer')],
      measures: [{ fn: 'max', columns: ['redeemed_at'], as: 'redeemed_at' }],
    }),
  },
  {
    key: 'gnosis-vpn-client/daily',
    query: 'vpn-traffic',
    title: 'Upstream volume, last 90 days',
    type: 'bar',
    config: built({
      filters: [upstream, ofClient('payer')],
      window: { column: 'day', fixed: '90d' },
      groups: [{ column: 'day' }],
      measures: [
        {
          fn: 'sum',
          columns: ['gigabytes'],
          as: 'gigabytes',
          format: 'gigabytes',
        },
      ],
    }),
  },
  {
    key: 'gnosis-vpn-client/relays',
    query: 'vpn-traffic',
    title: 'Relays paid',
    type: 'table',
    config: built({
      filters: [upstream, ofClient('payer')],
      groups: [{ column: 'relay' }],
      measures: [
        { fn: 'count', as: 'redemptions' },
        {
          fn: 'sum',
          columns: ['gigabytes'],
          as: 'gigabytes',
          label: 'upstream',
          format: 'gigabytes',
        },
      ],
      share: { of: 'redemptions', as: 'share' },
      sort: [{ column: 'gigabytes', desc: true }],
    }),
  },
];

const RANGE_VARIABLE = {
  name: 'range',
  label: 'Range',
  type: 'range',
  // A month is 31 days here, today and the thirty before it, as the
  // published Dune queries have always counted it.
  options: ['7d', '31d', '90d', 'all'],
  labels: {
    '7d': 'Last 7 days',
    '31d': 'Last 30 days',
    '90d': 'Last 90 days',
    all: 'All time',
  },
  default: '31d',
};

const NETWORK_VARIABLE = {
  name: 'network',
  label: 'Network',
  type: 'network',
  default: 'all',
};

const toClient = {
  var: 'client',
  dashboard: 'gnosis-vpn-client',
};

const dashboards: SeedDashboard[] = [
  {
    slug: 'gnosis-vpn',
    title: 'Gnosis VPN',
    description:
      'Who uses Gnosis VPN, how much traffic it carries and where, read from the HOPR network’s on-chain ticket redemptions.',
    visibility: 'public',
    variables: [
      NETWORK_VARIABLE,
      RANGE_VARIABLE,
      {
        name: 'direction',
        label: 'Direction',
        type: 'select',
        options: ['upstream', 'downstream'],
        labels: { upstream: 'Upstream', downstream: 'Downstream' },
        default: 'upstream',
      },
    ],
    widgets: [
      {
        kind: 'visualization',
        visualization: 'gnosis-vpn/monthly-active-users',
        width: 3,
        height: 120,
        options: { note: 'Distinct clients, last 30 days' },
      },
      {
        kind: 'visualization',
        visualization: 'gnosis-vpn/data-relayed',
        width: 3,
        height: 120,
        options: { note: 'Upstream and downstream combined, in the range' },
      },
      {
        kind: 'visualization',
        visualization: 'gnosis-vpn/redemptions',
        width: 2,
        height: 120,
        options: { note: 'Client-channel redemptions, in the range' },
      },
      {
        kind: 'visualization',
        visualization: 'gnosis-vpn/new-clients',
        width: 2,
        height: 120,
        options: { note: 'Client deployments, in the range' },
      },
      {
        kind: 'visualization',
        visualization: 'gnosis-vpn/active-channels',
        width: 2,
        height: 120,
      },
      {
        kind: 'text',
        text: 'Users and traffic',
        note: 'A user is a VPN client — an account that bound a key but never announced an address, so it is not relay infrastructure. Upstream volume is derived from the redemptions on client channels, priced at the winning probability in force at each block; downstream is what the configured exits pay relays for the return path.',
      },
      {
        kind: 'visualization',
        visualization: 'gnosis-vpn/active-users',
        width: 6,
        height: 280,
        options: {
          note: 'Each point counts distinct clients over the 30 days before it.',
        },
      },
      {
        kind: 'visualization',
        visualization: 'gnosis-vpn/volume',
        width: 6,
        height: 280,
        options: {
          note: 'Daily up to a month, weekly beyond. Upstream is paid for by the client and attributable to it; downstream is paid for by the exit, whose channels name no client.',
        },
      },
      {
        kind: 'visualization',
        visualization: 'gnosis-vpn/downstream-ratio',
        width: 4,
        height: 110,
      },
      {
        kind: 'visualization',
        visualization: 'gnosis-vpn/exits-seen',
        width: 4,
        height: 110,
        options: {
          note: 'Exits are configured per network on the Exits page.',
        },
      },
      {
        kind: 'visualization',
        visualization: 'gnosis-vpn/direction-agreement',
        width: 4,
        height: 110,
        options: {
          note: 'An answer follows its request within seconds, so one session should shade both grids the same way.',
        },
      },
      {
        kind: 'text',
        text: 'Daily activity',
        note: 'Who showed up each day, and when during the day the network carries traffic.',
      },
      {
        kind: 'visualization',
        visualization: 'gnosis-vpn/daily-users',
        width: 4,
        height: 280,
      },
      {
        kind: 'visualization',
        visualization: 'gnosis-vpn/retention',
        width: 4,
        height: 280,
        options: {
          note: 'Read a row left to right: it follows the clients deployed that month, and each square is the share of them relaying traffic that many months later. Month 0 is an activation rate. Not affected by the range.',
        },
      },
      {
        kind: 'visualization',
        visualization: 'gnosis-vpn/hours',
        width: 4,
        height: 280,
        options: {
          note: 'Share of volume in the chosen direction by weekday and hour, UTC.',
        },
      },
      {
        kind: 'text',
        text: 'Data volume by relayer',
        note: 'Estimated client traffic carried by each relay.',
      },
      {
        kind: 'visualization',
        visualization: 'gnosis-vpn/relayer-share',
        width: 4,
        height: 320,
        options: { note: 'Upstream volume.' },
      },
      {
        kind: 'visualization',
        visualization: 'gnosis-vpn/relayer-daily',
        width: 8,
        height: 320,
        options: {
          note: 'Split by the relay each client (upstream) or exit (downstream) paid. Downstream names no client, so it is a relay breakdown, never a client one.',
        },
      },
      {
        kind: 'text',
        text: 'Ticket parameters',
        note: 'The oracle values that convert redemptions into traffic, as they stand now. Each network sets its own, so pick one network to see them.',
      },
      {
        kind: 'visualization',
        visualization: 'gnosis-vpn/winning-probability',
        width: 4,
        height: 110,
        options: { note: 'Current network minimum', requires: 'network' },
      },
      {
        kind: 'visualization',
        visualization: 'gnosis-vpn/ticket-price',
        width: 4,
        height: 110,
        options: {
          note: 'Cost of relaying one packet, one hop',
          requires: 'network',
        },
      },
      {
        kind: 'visualization',
        visualization: 'gnosis-vpn/ticket-value',
        width: 4,
        height: 110,
        options: {
          note: 'Price ÷ probability, for one remaining hop',
          requires: 'network',
        },
      },
      {
        kind: 'text',
        text: 'Clients',
        note: 'Who used the network and when each client first appeared. Volume is upstream only — the traffic the client itself paid for. Pick a client to open its record.',
      },
      {
        kind: 'visualization',
        visualization: 'gnosis-vpn/top-clients',
        width: 6,
        height: 420,
        options: { link: { column: 'payer', ...toClient } },
      },
      {
        kind: 'visualization',
        visualization: 'gnosis-vpn/deployments',
        width: 6,
        height: 420,
        options: { link: { column: 'client', ...toClient } },
      },
      {
        kind: 'text',
        text: 'Most recent redemptions',
        note: 'The latest client redemptions, newest first. Upstream only — a downstream redemption is paid by an exit and names no client.',
      },
      {
        kind: 'visualization',
        visualization: 'gnosis-vpn/feed',
        width: 12,
        height: 420,
        options: { link: { column: 'client', ...toClient } },
      },
      {
        kind: 'text',
        text: 'How these figures are made',
        note: 'Blokli appends a channel state row per on-chain event, and only TicketRedeemed advances the ticket index, so a row whose index advances is a redemption. A client paying a relay is upstream; a configured exit paying a relay is the return path, downstream. Each redemption accounts for 650 / (2^30 × p) GB, where p is the winning probability from the oracle’s update history at that block. Every figure here is a saved query and a chart over its result: open them in the studio to see exactly how.',
      },
      {
        kind: 'visualization',
        visualization: 'gnosis-vpn/contracts',
        width: 12,
        height: 300,
      },
    ],
  },
  {
    slug: 'gnosis-vpn-client',
    title: 'Gnosis VPN client',
    description:
      'One VPN client’s record: when it was deployed, what it used, and which relays it paid.',
    visibility: 'public',
    variables: [
      NETWORK_VARIABLE,
      { name: 'client', label: 'Client', type: 'text' },
    ],
    widgets: [
      {
        kind: 'text',
        text: 'Client record',
        note: 'A client leaves no trace of its own on chain: what is visible is a relay redeeming a ticket the client issued. First and last seen are the bounds of that trace. Open a client from the Gnosis VPN dashboard, or set one in the address bar.',
      },
      ...(
        [
          ['gnosis-vpn-client/deployed', 'Key binding on chain'],
          ['gnosis-vpn-client/first-seen', 'First redemption'],
          ['gnosis-vpn-client/last-seen', 'Latest redemption'],
          ['gnosis-vpn-client/redemptions', undefined],
          ['gnosis-vpn-client/volume', undefined],
          [
            'gnosis-vpn-client/active-days',
            'Days a relay redeemed its tickets',
          ],
        ] as const
      ).map(
        ([visualization, note]): SeedWidget => ({
          kind: 'visualization',
          visualization,
          width: 4,
          height: 110,
          options: { requires: 'client', ...(note ? { note } : {}) },
        }),
      ),
      {
        kind: 'visualization',
        visualization: 'gnosis-vpn-client/daily',
        width: 8,
        height: 280,
        options: { requires: 'client' },
      },
      {
        kind: 'visualization',
        visualization: 'gnosis-vpn-client/relays',
        width: 4,
        height: 280,
        options: { requires: 'client' },
      },
    ],
  },
];

export const GNOSIS_VPN: Seed = {
  name: 'gnosis-vpn',
  title: 'Gnosis VPN dashboard',
  queries: [
    // Fragments come first, each after the ones it uses, so every version
    // saved during an install compiles against fragments that already exist.
    {
      slug: 'hex',
      title: 'Hex',
      description:
        'Expression fragment: bytes as a 0x-prefixed hex string. {{> hex(address)}}.',
      kind: 'fragment',
    },
    {
      slug: 'uint256',
      title: 'uint256',
      description:
        'Expression fragment: a 32-byte big-endian integer as an exact numeric. {{> uint256(balance)}}.',
      kind: 'fragment',
    },
    {
      slug: 'decode-win-prob',
      title: 'Decode winning probability',
      description:
        'Expression fragment: the 7-byte encoded winning probability as a number between 0 and 1.',
      kind: 'fragment',
    },
    {
      slug: 'vpn-nodes',
      title: 'VPN nodes',
      description:
        'Fragment: every announced node (relays and exits), with its account id and address.',
      kind: 'fragment',
    },
    {
      slug: 'vpn-clients',
      title: 'VPN clients',
      description:
        'Fragment: every account that never announced — the VPN clients — with the block it was deployed in.',
      kind: 'fragment',
    },
    {
      slug: 'oracle-updates',
      title: 'Oracle updates',
      description:
        'Fragment: every winning-probability and ticket-price update from the oracle logs, raw value and position.',
      kind: 'fragment',
    },
    {
      slug: 'vpn-redemptions',
      title: 'VPN redemptions',
      description:
        'Fragment: every ticket redemption that carried VPN traffic, upstream or downstream, with its block and tickets.',
      kind: 'fragment',
    },
    {
      slug: 'win-probability',
      title: 'Winning probability history',
      description:
        'Fragment: the winning probability in force over each range of blocks, from the oracle logs.',
      kind: 'fragment',
    },
    {
      slug: 'vpn-traffic',
      title: 'VPN traffic',
      description:
        'Every VPN redemption, dated, with its direction, payer, relay and data volume.',
      kind: 'query',
      refreshSeconds: 300,
    },
    {
      slug: 'client-activity',
      title: 'Client activity',
      description:
        'Each day each client was active — by redemption or by being deployed — with its deployment day.',
      kind: 'query',
      refreshSeconds: 300,
    },
    {
      slug: 'client-deployments',
      title: 'Client deployments',
      description: 'Every VPN client deployment, newest first.',
      kind: 'query',
      refreshSeconds: 300,
    },
    {
      slug: 'recent-redemptions',
      title: 'Recent redemptions',
      description:
        'The 500 most recent client redemptions, with their channel.',
      kind: 'query',
      refreshSeconds: 300,
    },
    {
      slug: 'network-state',
      title: 'Network state',
      description:
        'Accounts, safes, open channels and balances at the last indexed block.',
      kind: 'query',
      refreshSeconds: 300,
    },
    {
      slug: 'ticket-parameters',
      title: 'Ticket parameters',
      description:
        'Current winning probability, ticket price and ticket value.',
      kind: 'query',
      refreshSeconds: 600,
      combine: 'hidden',
    },
    {
      slug: 'indexed-contracts',
      title: 'Indexed contracts',
      description: 'The contracts this index subscribes to, by role.',
      kind: 'query',
      refreshSeconds: 3600,
    },
  ],
  visualizations,
  dashboards,
};

export const SEEDS: Record<string, Seed> = { [GNOSIS_VPN.name]: GNOSIS_VPN };
