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

function count(input: number | null) {
  return input === null ? "—" : new Intl.NumberFormat("en-US").format(input);
}

function volume(input: number | null) {
  if (input === null) return "—";
  const [value, unit] = input >= 1000 ? [input / 1000, "GB"] : [input, "MB"];
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
            Gnosis VPN usage measured directly from Gnosis Chain. Every figure below is
            reconstructed from ticket redemptions and node announcements indexed by
            Blokli—no self-reported numbers.
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
          figure={volume(data.totals.megabytes7d)}
          note={`${volume(data.totals.megabytesTotal)} cumulative`}
        />
        <Metric
          eyebrow="ACTIVE CHANNELS"
          figure={count(data.openChannels)}
          note={`${compactToken(data.channelBalance)} allocated`}
        />
      </section>

      <section className="section" id="users">
        <div className="section-heading">
          <div>
            <span className="section-index">01</span>
            <h2>Unique active users</h2>
          </div>
          <p>
            An account counts as active when it sourced a channel that saw a ticket
            redemption inside the window, or announced itself inside the window.
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
                  <stop offset="0%" stopColor="#ffd84d" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="#ffd84d" stopOpacity={0} />
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
              <Tooltip
                labelFormatter={formatDay}
                contentStyle={{
                  background: "#161a1f",
                  border: "1px solid #333940",
                  borderRadius: 2,
                }}
              />
              <Area
                type="monotone"
                dataKey="monthly"
                name="30-day active"
                stroke="#ffd84d"
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
              The series appears once the index database reports redemptions or
              announcements.
            </div>
          )}
          <p className="chart-note">
            Each point counts distinct accounts over the preceding 30 and 7 days, so the
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
            Redemptions are counted per channel state transition. Volume converts the
            redeemed wxHOPR into packets at the indexed ticket price, one packet
            carrying {new Intl.NumberFormat("en").format(1038)} bytes of payload.
          </p>
        </div>
        <div className="network-grid">
          <div className="chart-card service-chart">
            <div className="chart-title">
              <div>
                <span>PER WEEK</span>
                <h3>Redemptions and data volume</h3>
              </div>
              <div className="axis-badge">
                {data.timebase === "rpc" ? "TIME · RPC RESOLVED" : "TIME · ESTIMATED"}
              </div>
            </div>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart
                data={data.weeks}
                barGap={3}
                margin={{ top: 20, right: 10, left: -28, bottom: 0 }}
              >
                <CartesianGrid vertical={false} stroke="#e6e2d8" />
                <XAxis
                  dataKey="label"
                  axisLine={false}
                  tickLine={false}
                  tick={LIGHT_AXIS}
                  minTickGap={24}
                />
                <YAxis
                  yAxisId="left"
                  allowDecimals={false}
                  axisLine={false}
                  tickLine={false}
                  tick={LIGHT_AXIS}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  axisLine={false}
                  tickLine={false}
                  tick={LIGHT_AXIS}
                />
                <Tooltip
                  cursor={{ fill: "#f2eee5" }}
                  contentStyle={{ border: "1px solid #d9d5cb", borderRadius: 2 }}
                  formatter={(input: unknown, name: unknown) =>
                    name === "Data volume"
                      ? volume(Number(input))
                      : new Intl.NumberFormat("en").format(Number(input))
                  }
                />
                <Bar
                  yAxisId="left"
                  dataKey="redemptions"
                  name="Redemptions"
                  fill="#17191c"
                  radius={[2, 2, 0, 0]}
                />
                <Bar
                  yAxisId="right"
                  dataKey="megabytes"
                  name="Data volume"
                  fill="#ffd84d"
                  radius={[2, 2, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
            {!hasWeeks && (
              <div className="empty-overlay">
                No redemptions have been indexed for this network yet.
              </div>
            )}
          </div>
          <div className="network-stats">
            <Metric
              eyebrow="TOTAL REDEMPTIONS"
              figure={count(data.totals.redemptionsTotal)}
              note="Ticket redemptions across all channels"
            />
            <Metric
              eyebrow="TOTAL DATA RELAYED"
              figure={volume(data.totals.megabytesTotal)}
              note={`${compactToken(data.totals.redeemedWeiTotal)} redeemed`}
            />
            <Metric
              eyebrow="TICKET PRICE"
              figure={compactToken(data.ticketPriceWei)}
              note="Indexed from chain_info"
            />
          </div>
        </div>
      </section>

      <section className="section" id="relayers">
        <div className="section-heading">
          <div>
            <span className="section-index">03</span>
            <h2>Relayer distribution</h2>
          </div>
          <p>
            Where the last seven days of redemptions landed. A flat distribution means
            traffic is spread across many relays rather than concentrated in a few.
          </p>
        </div>
        <div className="network-grid">
          <div className="chart-card service-chart">
            <div className="chart-title">
              <div>
                <span>LAST 7 DAYS</span>
                <h3>Redemptions by destination</h3>
              </div>
            </div>
            <ol className="relayer-list">
              {data.relayers.map((relayer) => (
                <li key={relayer.address}>
                  <code>{shortAddress(relayer.address)}</code>
                  <span className="relayer-bar">
                    <i style={{ width: `${Math.max(2, relayer.share * 100)}%` }} />
                  </span>
                  <strong>{count(relayer.redemptions)}</strong>
                </li>
              ))}
            </ol>
            {!data.relayers.length && (
              <div className="empty-overlay">
                No redemptions were indexed in the last seven days.
              </div>
            )}
          </div>
          <div className="network-stats">
            <Metric
              eyebrow="ON-CHAIN ACCOUNTS"
              figure={count(data.accounts)}
              note="Unique on-chain identities indexed"
            />
            <Metric
              eyebrow="INDEXED SAFES"
              figure={count(data.safes)}
              note={`${compactToken(data.safeBalance)} held`}
            />
            <Metric
              eyebrow="INDEX SCHEMA"
              figure={data.schemaVersion ?? "—"}
              note="Blokli database schema version"
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
            <h3>Redemptions</h3>
            <p>
              Blokli appends a channel state row per on-chain event. A row whose ticket
              index advances is a redemption; the drop in channel balance is what the
              relay was paid.
            </p>
          </div>
          <div>
            <span>02</span>
            <h3>Active users</h3>
            <p>
              Distinct channel sources with a redemption in the window, unioned with
              accounts that announced in the window. Counted per day over trailing 7-
              and 30-day windows.
            </p>
          </div>
          <div>
            <span>03</span>
            <h3>Data volume</h3>
            <p>
              Redeemed wxHOPR divided by the indexed ticket price gives the expected
              packets paid for; each carries 1,038 bytes. Volume is counted once per
              paid relay hop.
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
