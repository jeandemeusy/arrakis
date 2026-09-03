"use client";

import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Database, ExternalLink, Radio, ShieldCheck, Users } from "lucide-react";

import type { AnalyticsSnapshot } from "@/lib/analytics";

export type DashboardData = AnalyticsSnapshot;

const AXIS = { fill: "#89919b", fontSize: 11 };
const LIGHT_AXIS = { fill: "#77756f", fontSize: 11 };
const YELLOW = "#ffd84d";
const INK = "#17191c";
const DARK_TOOLTIP = {
  background: "#161a1f",
  border: "1px solid #333940",
  borderRadius: 2,
};
const LIGHT_TOOLTIP = { border: "1px solid #d9d5cb", borderRadius: 2 };

function count(input: number | null) {
  return input === null ? "—" : new Intl.NumberFormat("en-US").format(input);
}

/** Volume arrives in gigabytes; step down so small numbers stay readable. */
function volume(input: number | null) {
  if (input === null) return "—";
  const [value, unit] =
    input >= 1 ? [input, "GB"] : input >= 0.001 ? [input * 1000, "MB"] : [input * 1e6, "KB"];
  return `${new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(value)} ${unit}`;
}

function compactToken(input: string | null) {
  if (!input) return "—";
  const number = Number(BigInt(input) / 1_000_000_000_000_000n) / 1_000;
  if (!Number.isFinite(number)) return input;
  return `${new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(number)} wxHOPR`;
}

function shortAddress(address: string) {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

// Recharts hands both tick and tooltip labels through as ReactNode.
function formatDay(value: unknown) {
  if (typeof value !== "string") return "";
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function Metric({
  eyebrow,
  figure,
  note,
}: {
  eyebrow: string;
  figure: string;
  note: string;
}) {
  return (
    <div className="metric">
      <span>{eyebrow}</span>
      <strong>{figure}</strong>
      <p>{note}</p>
    </div>
  );
}

export default function Dashboard({ data }: { data: DashboardData }) {
  const live = data.source !== "unavailable";
  const hasUsers = data.activeUsers.length > 0;
  const hasWeeks = data.weeks.length > 0;

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Gnosis VPN network intelligence home">
          <span className="brand-mark">
            <span />
          </span>
          <span>
            GNOSIS<span className="brand-light">VPN</span>
          </span>
        </a>
        <nav aria-label="Dashboard navigation">
          <a href="#users">Active users</a>
          <a href="#usage">Usage</a>
          <a href="#growth">Growth</a>
          <a href="#relayers">Relayers</a>
          <a href="#methodology">Methodology</a>
        </nav>
        <a
          className="source-link"
          href="https://github.com/hoprnet/blokli"
          target="_blank"
          rel="noreferrer"
        >
          Blokli source <ExternalLink size={13} />
        </a>
      </header>

      <section className="intro" id="top">
        <div>
          <div className="status-line">
            <span className={data.source === "live" ? "live-dot" : "unavailable-dot"} />
            {data.source === "live"
              ? "LIVE · BLOKLI INDEX DATA"
              : data.source === "degraded"
                ? "PARTIAL · SOME SERIES UNAVAILABLE"
                : "DATA SOURCE UNAVAILABLE"}
          </div>
          <h1>
            Private access.
            <br />
            Public proof.
          </h1>
        </div>
        <div className="intro-copy">
          <p>
            Gnosis VPN client usage measured directly from Gnosis Chain. Every figure
            below counts traffic paid for by VPN clients—accounts that never announced
            themselves as relays—reconstructed from ticket redemptions indexed by Blokli.
          </p>
          <div className="asof">
            <span>LAST INDEXED BLOCK</span>
            <strong>{data.blockNumber ? `#${count(data.blockNumber)}` : "—"}</strong>
            <span>OBSERVED</span>
            <strong>
              {new Date(data.observedAt).toLocaleDateString("en-GB", {
                day: "2-digit",
                month: "short",
                year: "numeric",
              })}
            </strong>
          </div>
        </div>
      </section>

      <section className="headline-grid" aria-label="Headline metrics">
        <div className="mau-card">
          <div className="metric-kicker">
            <Users size={15} /> MONTHLY ACTIVE USERS
          </div>
          <div className="mau-number">{count(data.totals.monthlyActiveUsers)}</div>
          <div className="mau-footer">
            <span>
              <Radio size={14} /> {count(data.totals.weeklyActiveUsers)} weekly active
            </span>
            <small>Trailing 30 and 7 days</small>
          </div>
        </div>
        <Metric
          eyebrow="REDEMPTIONS · 7 DAYS"
          figure={count(data.totals.redemptions7d)}
          note={`${count(data.totals.redemptionsTotal)} since indexing began`}
        />
        <Metric
          eyebrow="DATA RELAYED · 7 DAYS"
          figure={volume(data.totals.gigabytes7d)}
          note={`${volume(data.totals.gigabytesTotal)} cumulative`}
        />
        <Metric
          eyebrow="ALL-TIME CLIENTS"
          figure={count(data.totals.allTimeUsers)}
          note={`${count(data.totals.relayers7d)} relayers served them this week`}
        />
      </section>

      <section className="section" id="users">
        <div className="section-heading">
          <div>
            <span className="section-index">01</span>
            <h2>Unique active users</h2>
          </div>
          <p>
            A user is a VPN client that paid for a session in the window—an account that
            opened a channel and settled tickets on it, and that never announced itself
            as relay infrastructure.
          </p>
        </div>
        <div className="chart-card main-chart">
          <div className="chart-title">
            <div>
              <span>DAILY SNAPSHOT OF TRAILING WINDOWS</span>
              <h3>Monthly and weekly active users</h3>
            </div>
            <div className="legend">
              <i className="actual" />
              30-day <i className="target" />
              7-day
            </div>
          </div>
          <ResponsiveContainer width="100%" height={330}>
            <ComposedChart
              data={data.activeUsers}
              margin={{ top: 24, right: 18, left: -18, bottom: 0 }}
            >
              <defs>
                <linearGradient id="fillMonthly" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={YELLOW} stopOpacity={0.45} />
                  <stop offset="100%" stopColor={YELLOW} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="#262b31" strokeDasharray="2 5" />
              <XAxis
                dataKey="date"
                axisLine={false}
                tickLine={false}
                tick={AXIS}
                minTickGap={48}
                tickFormatter={formatDay}
              />
              <YAxis axisLine={false} tickLine={false} tick={AXIS} allowDecimals={false} />
              <Tooltip labelFormatter={formatDay} contentStyle={DARK_TOOLTIP} />
              <Area
                type="monotone"
                dataKey="monthly"
                name="30-day active"
                stroke={YELLOW}
                fill="url(#fillMonthly)"
                strokeWidth={3}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="weekly"
                name="7-day active"
                stroke="#737b85"
                strokeWidth={1.5}
                dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
          {!hasUsers && (
            <div className="empty-overlay">
              The series appears once the index database reports client redemptions.
            </div>
          )}
          <p className="chart-note">
            Each point counts distinct clients over the preceding 30 and 7 days, so the
            two lines converge when activity is concentrated in a single week.
          </p>
        </div>
      </section>

      <section className="section" id="usage">
        <div className="section-heading">
          <div>
            <span className="section-index">02</span>
            <h2>Relayed traffic</h2>
          </div>
          <p>
            Each redemption settles a batch of tickets, and each ticket accounts for 650
            bytes scaled by the winning probability in force when it was redeemed.
          </p>
        </div>
        <div className="chart-split">
          <div className="chart-card service-chart">
            <div className="chart-title">
              <div>
                <span>PER WEEK</span>
                <h3>Data volume</h3>
              </div>
              <div className="axis-badge">
                {data.winProbability === "historical"
                  ? "WIN PROB · HISTORICAL"
                  : data.winProbability === "current"
                    ? "WIN PROB · CURRENT"
                    : "WIN PROB · ASSUMED 1"}
              </div>
            </div>
            <ResponsiveContainer width="100%" height={230}>
              <BarChart data={data.weeks} margin={{ top: 20, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#e6e2d8" />
                <XAxis
                  dataKey="label"
                  axisLine={false}
                  tickLine={false}
                  tick={LIGHT_AXIS}
                  minTickGap={24}
                />
                <YAxis axisLine={false} tickLine={false} tick={LIGHT_AXIS} />
                <Tooltip
                  cursor={{ fill: "#f2eee5" }}
                  contentStyle={LIGHT_TOOLTIP}
                  formatter={(input: unknown) => volume(Number(input))}
                />
                <Bar dataKey="gigabytes" name="Data volume" fill={YELLOW} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
            {!hasWeeks && (
              <div className="empty-overlay">No client redemptions have been indexed yet.</div>
            )}
          </div>
          <div className="chart-card service-chart">
            <div className="chart-title">
              <div>
                <span>PER WEEK</span>
                <h3>Redemptions</h3>
              </div>
              <div className="axis-badge">
                {data.timebase === "rpc" ? "TIME · RPC RESOLVED" : "TIME · ESTIMATED"}
              </div>
            </div>
            <ResponsiveContainer width="100%" height={230}>
              <BarChart data={data.weeks} margin={{ top: 20, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#e6e2d8" />
                <XAxis
                  dataKey="label"
                  axisLine={false}
                  tickLine={false}
                  tick={LIGHT_AXIS}
                  minTickGap={24}
                />
                <YAxis
                  allowDecimals={false}
                  axisLine={false}
                  tickLine={false}
                  tick={LIGHT_AXIS}
                />
                <Tooltip cursor={{ fill: "#f2eee5" }} contentStyle={LIGHT_TOOLTIP} />
                <Bar dataKey="redemptions" name="Redemptions" fill={INK} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
            {!hasWeeks && (
              <div className="empty-overlay">No client redemptions have been indexed yet.</div>
            )}
          </div>
        </div>
        <div className="network-stats network-stats-row">
          <Metric
            eyebrow="TOTAL REDEMPTIONS"
            figure={count(data.totals.redemptionsTotal)}
            note={`${count(data.totals.ticketsTotal)} tickets settled`}
          />
          <Metric
            eyebrow="TOTAL DATA RELAYED"
            figure={volume(data.totals.gigabytesTotal)}
            note="Client traffic since indexing began"
          />
          <Metric
            eyebrow="ACTIVE CHANNELS"
            figure={count(data.openChannels)}
            note={`${compactToken(data.channelBalance)} allocated`}
          />
        </div>
      </section>

      <section className="section" id="growth">
        <div className="section-heading">
          <div>
            <span className="section-index">03</span>
            <h2>Cumulative growth</h2>
          </div>
          <p>
            The running totals behind the weekly bars—useful for reading the trajectory
            rather than week-to-week noise.
          </p>
        </div>
        <div className="chart-card main-chart">
          <div className="chart-title">
            <div>
              <span>SINCE INDEXING BEGAN</span>
              <h3>Cumulative volume and redemptions</h3>
            </div>
            <div className="legend">
              <i className="actual" />
              Volume <i className="target" />
              Redemptions
            </div>
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={data.weeks} margin={{ top: 24, right: 8, left: -18, bottom: 0 }}>
              <defs>
                <linearGradient id="fillCumulative" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={YELLOW} stopOpacity={0.45} />
                  <stop offset="100%" stopColor={YELLOW} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="#262b31" strokeDasharray="2 5" />
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
                contentStyle={DARK_TOOLTIP}
                formatter={(input: unknown, name: unknown) =>
                  name === "Cumulative volume"
                    ? volume(Number(input))
                    : new Intl.NumberFormat("en").format(Number(input))
                }
              />
              <Area
                yAxisId="left"
                type="monotone"
                dataKey="cumulativeGigabytes"
                name="Cumulative volume"
                stroke={YELLOW}
                fill="url(#fillCumulative)"
                strokeWidth={3}
                dot={false}
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="cumulativeRedemptions"
                name="Cumulative redemptions"
                stroke="#737b85"
                strokeWidth={1.5}
                dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
          {!hasWeeks && (
            <div className="empty-overlay">No client redemptions have been indexed yet.</div>
          )}
        </div>
      </section>

      <section className="section" id="relayers">
        <div className="section-heading">
          <div>
            <span className="section-index">04</span>
            <h2>Redemptions by relayer</h2>
          </div>
          <p>
            Which relays carried client traffic over the last seven days. A flat
            distribution means sessions are spread across many relays rather than
            concentrated in a few.
          </p>
        </div>
        <div className="network-grid">
          <div className="chart-card service-chart">
            <div className="chart-title">
              <div>
                <span>LAST 7 DAYS</span>
                <h3>Redemptions by relayer</h3>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart
                data={data.relayers}
                layout="vertical"
                margin={{ top: 10, right: 16, left: 8, bottom: 0 }}
              >
                <CartesianGrid horizontal={false} stroke="#e6e2d8" />
                <XAxis
                  type="number"
                  axisLine={false}
                  tickLine={false}
                  tick={LIGHT_AXIS}
                  allowDecimals={false}
                />
                <YAxis
                  type="category"
                  dataKey="address"
                  width={132}
                  axisLine={false}
                  tickLine={false}
                  tick={LIGHT_AXIS}
                  tickFormatter={(value: unknown) =>
                    typeof value === "string" ? shortAddress(value) : ""
                  }
                />
                <Tooltip
                  cursor={{ fill: "#f2eee5" }}
                  contentStyle={LIGHT_TOOLTIP}
                  formatter={(input: unknown) =>
                    new Intl.NumberFormat("en").format(Number(input))
                  }
                />
                <Bar
                  dataKey="redemptions"
                  name="Redemptions"
                  fill={INK}
                  radius={[0, 2, 2, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
            {!data.relayers.length && (
              <div className="empty-overlay">
                No client redemptions were indexed in the last seven days.
              </div>
            )}
          </div>
          <div className="network-stats">
            <Metric
              eyebrow="RELAYERS SERVING CLIENTS"
              figure={count(data.totals.relayers7d)}
              note="Distinct destinations, last 7 days"
            />
            <Metric
              eyebrow="INDEXED SAFES"
              figure={count(data.safes)}
              note={`${compactToken(data.safeBalance)} held`}
            />
            <Metric
              eyebrow="INDEX SCHEMA"
              figure={data.schemaVersion ?? "—"}
              note={`${count(data.accounts)} on-chain accounts indexed`}
            />
          </div>
        </div>
      </section>

      <section className="methodology" id="methodology">
        <div className="method-title">
          <Database size={18} />
          <span>DATA PROVENANCE</span>
        </div>
        <h2>Designed to be cited.</h2>
        <div className="method-grid">
          <div>
            <span>01</span>
            <h3>Client traffic only</h3>
            <p>
              Relays announce themselves on chain. A channel sourced by an account that
              never announced is a VPN client paying for its own sessions, so only those
              channels are counted.
            </p>
          </div>
          <div>
            <span>02</span>
            <h3>Redemptions</h3>
            <p>
              Blokli appends a channel state row per on-chain event, and only
              TicketRedeemed advances the ticket index. A row whose index advances is a
              redemption; the increment is the tickets it settled.
            </p>
          </div>
          <div>
            <span>03</span>
            <h3>Data volume</h3>
            <p>
              Each settled ticket accounts for 650 bytes scaled by the network winning
              probability, read from the oracle&rsquo;s update history so every redemption
              uses the value in force at its block.
            </p>
          </div>
        </div>
        {data.warnings.length > 0 && (
          <ul className="data-warning">
            {data.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
        <div className="integrity">
          <ShieldCheck size={16} />
          <span>
            {live ? "POSTGRESQL → BACKEND → PUBLIC DASHBOARD" : "DATABASE CONNECTION PENDING"}
          </span>
          <code>Schema {data.schemaVersion ?? "unavailable"}</code>
        </div>
      </section>

      <footer>
        <span>GNOSIS VPN × HOPR</span>
        <p>On-chain network intelligence powered by Blokli.</p>
        <a href="#top">Back to top ↑</a>
      </footer>
    </main>
  );
}
