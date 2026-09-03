"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ArrowUpRight,
  Check,
  Database,
  ExternalLink,
  Radio,
  ShieldCheck,
} from "lucide-react";

export type DashboardData = {
  source: "live" | "unavailable";
  axisMode: "time" | "block";
  observedAt: string;
  blokliUrl: string | null;
  schemaVersion: string | null;
  blockNumber: number;
  accounts: number | null;
  openChannels: number | null;
  channelBalance: string | null;
  safes: number | null;
  safeBalance: string | null;
  exits: number | null;
  activity: Array<{
    key: string;
    label: string;
    activeParticipants: number;
    redemptions: number;
    redeemedWei: string;
  }>;
  warning: string | null;
};

const adoption = [
  { period: "M12", users: 100, target: 100 },
  { period: "M18", users: null, target: 150 },
  { period: "M24", users: null, target: 500 },
];

const milestones = [
  { label: "MVP", value: 100, status: "Reached", date: "MONTH 12" },
  { label: "Version 1", value: 150, status: "Next", date: "MONTH 18" },
  { label: "Version 2", value: 500, status: "Roadmap", date: "MONTH 24" },
];

function value(input: number | null) {
  return input === null ? "—" : new Intl.NumberFormat("en-US").format(input);
}

function compactToken(input: string | null) {
  if (!input) return "—";
  const number = Number(BigInt(input) / 1_000_000_000_000_000n) / 1_000;
  if (!Number.isFinite(number)) return input;
  return `${new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(number)} wxHOPR`;
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
  const live = data.source === "live";
  const activityChart = data.activity.length
    ? data.activity
    : [{ key: "waiting", label: "Waiting", activeParticipants: 0, redemptions: 0, redeemedWei: "0" }];
  const provenance = data.blokliUrl
    ? (() => {
        try {
          return new URL(data.blokliUrl).host;
        } catch {
          return data.blokliUrl;
        }
      })()
    : "Configured index database";

  return (
    <main>
      <header className="topbar">
        <a
          className="brand"
          href="#top"
          aria-label="Gnosis VPN network intelligence home"
        >
          <span className="brand-mark">
            <span />
          </span>
          <span>
            GNOSIS<span className="brand-light">VPN</span>
          </span>
        </a>
        <nav aria-label="Dashboard navigation">
          <a href="#adoption">Adoption</a>
          <a href="#network">Network</a>
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
            <span className={live ? "live-dot" : "unavailable-dot"} />
            {live
              ? "LIVE · BLOKLI INDEX DATA"
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
            A transparent view of Gnosis VPN adoption and the HOPR
            infrastructure carrying it—built from finalized Gnosis Chain events
            indexed by Blokli.
          </p>
          <div className="asof">
            <span>NETWORK</span>
            <strong>{provenance}</strong>
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
            <Radio size={15} /> REPORTED ACTIVE USERS
          </div>
          <div className="mau-number">
            100<span>+</span>
          </div>
          <div className="mau-footer">
            <span>
              <ArrowUpRight size={14} /> MVP threshold reached
            </span>
            <small>Reported June 2026</small>
          </div>
        </div>
        <Metric
          eyebrow="ON-CHAIN ACCOUNTS"
          figure={value(data.accounts)}
          note={
            live
              ? "Unique on-chain identities indexed"
              : "Available when the index database responds"
          }
        />
        <Metric
          eyebrow="ACTIVE CHANNELS"
          figure={value(data.openChannels)}
          note={
            live
              ? compactToken(data.channelBalance) + " allocated"
              : "Available when the index database responds"
          }
        />
        <Metric
          eyebrow="REGISTERED EXITS"
          figure={value(data.exits)}
          note={
            live
              ? "gvpn:exit registry entries"
              : "Available when the index database responds"
          }
        />
      </section>

      <section className="section" id="adoption">
        <div className="section-heading">
          <div>
            <span className="section-index">01</span>
            <h2>Adoption trajectory</h2>
          </div>
          <p>
            The public milestone series separates reported users from
            forward-looking roadmap targets.
          </p>
        </div>
        <div className="chart-layout">
          <div className="chart-card main-chart">
            <div className="chart-title">
              <div>
                <span>ACTIVE USERS & ROADMAP</span>
                <h3>From proof of concept to scale</h3>
              </div>
              <div className="legend">
                <i className="actual" />
                Reported <i className="target" />
                Target
              </div>
            </div>
            <ResponsiveContainer width="100%" height={330}>
              <AreaChart
                data={adoption}
                margin={{ top: 24, right: 18, left: -18, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="fillUsers" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ffd84d" stopOpacity={0.45} />
                    <stop offset="100%" stopColor="#ffd84d" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  vertical={false}
                  stroke="#262b31"
                  strokeDasharray="2 5"
                />
                <XAxis
                  dataKey="period"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: "#89919b", fontSize: 11 }}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: "#89919b", fontSize: 11 }}
                  domain={[0, 520]}
                  ticks={[0, 100, 250, 500]}
                />
                <Tooltip
                  contentStyle={{
                    background: "#161a1f",
                    border: "1px solid #333940",
                    borderRadius: 2,
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="target"
                  stroke="#737b85"
                  strokeDasharray="4 5"
                  fill="none"
                  strokeWidth={1.5}
                  connectNulls
                />
                <Area
                  type="monotone"
                  dataKey="users"
                  stroke="#ffd84d"
                  fill="url(#fillUsers)"
                  strokeWidth={3}
                  connectNulls={false}
                />
                <ReferenceLine y={100} stroke="#ffd84d" strokeOpacity={0.25} />
              </AreaChart>
            </ResponsiveContainer>
            <p className="chart-note">
              The 100+ figure is the latest published program update. It is
              deliberately separated from on-chain participation observed by
              Blokli.
            </p>
          </div>
          <aside className="milestones">
            <span className="aside-label">PROGRAM MILESTONES</span>
            {milestones.map((item, index) => (
              <div className="milestone" key={item.label}>
                <div className="milestone-line">
                  <span className={index === 0 ? "complete" : ""}>
                    {index === 0 ? <Check size={12} /> : index + 1}
                  </span>
                  <i />
                </div>
                <div>
                  <small>{item.date}</small>
                  <h3>{item.label}</h3>
                  <strong>{item.value} MAU</strong>
                  <em>{item.status}</em>
                </div>
              </div>
            ))}
          </aside>
        </div>
      </section>

      <section className="section" id="network">
        <div className="section-heading">
          <div>
            <span className="section-index">02</span>
            <h2>Network capacity</h2>
          </div>
          <p>
            Capital, services and ticket-redemption activity underpin the user
            story. These figures are calculated from Blokli’s index database.
          </p>
        </div>
        <div className="network-grid">
          <div className="chart-card service-chart">
            <div className="chart-title">
              <div>
                <span>ON-CHAIN ACTIVITY</span>
                <h3>Ticket redemptions & active participants</h3>
              </div>
              <div className="axis-badge">
                {data.axisMode === "time" ? "TIME · RPC RESOLVED" : "BLOCK AXIS"}
              </div>
            </div>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart
                data={activityChart}
                barGap={3}
                margin={{ top: 20, right: 10, left: -28, bottom: 0 }}
              >
                <CartesianGrid vertical={false} stroke="#e6e2d8" />
                <XAxis
                  dataKey="label"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: "#77756f", fontSize: 11 }}
                />
                <YAxis
                  allowDecimals={false}
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: "#77756f", fontSize: 11 }}
                />
                <Tooltip
                  cursor={{ fill: "#f2eee5" }}
                  contentStyle={{
                    border: "1px solid #d9d5cb",
                    borderRadius: 2,
                  }}
                />
                <Bar
                  dataKey="activeParticipants"
                  name="Active participants"
                  fill="#17191c"
                  radius={[2, 2, 0, 0]}
                />
                <Bar dataKey="redemptions" name="Redemptions" fill="#ffd84d" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
            {!live && (
              <div className="empty-overlay">
                Live series appears when the configured Blokli index database
                is reachable.
              </div>
            )}
            {data.warning && <p className="data-warning">{data.warning}</p>}
          </div>
          <div className="network-stats">
            <Metric
              eyebrow="INDEXED SAFES"
              figure={value(data.safes)}
              note="User-controlled on-chain accounts"
            />
            <Metric
              eyebrow="SAFE LIQUIDITY"
              figure={compactToken(data.safeBalance)}
              note="Indexed wxHOPR holdings"
            />
            <Metric
              eyebrow="FINALIZED BLOCK"
              figure={data.blockNumber ? `#${value(data.blockNumber)}` : "—"}
              note={
                data.schemaVersion
                  ? `Blokli schema ${data.schemaVersion}`
                  : "Latest indexed block"
              }
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
            <h3>Canonical source</h3>
            <p>
              Smart contract events on Gnosis Chain, decoded and indexed by
              Blokli.
            </p>
          </div>
          <div>
            <span>02</span>
            <h3>Finality aware</h3>
            <p>
              Versioned SQL reads the same current-state views maintained by
              Blokli and exposes the latest indexed block.
            </p>
          </div>
          <div>
            <span>03</span>
            <h3>Definition first</h3>
            <p>
              Block timestamps are resolved through the configured RPC and
              cached. Without an RPC, history remains block-number based.
            </p>
          </div>
        </div>
        <div className="integrity">
          <ShieldCheck size={16} />
          <span>
            {live ? "POSTGRESQL → BACKEND → PUBLIC DASHBOARD" : "DATABASE CONNECTION PENDING"}
          </span>
          <code>{provenance}</code>
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
