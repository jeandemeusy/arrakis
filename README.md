# Gnosis VPN Network Intelligence

A public, read-only investor dashboard powered by a Blokli index database. The
application is intentionally self-contained so it can live in a dedicated
repository and be deployed beside any Blokli instance.

## Data path

`Blokli PostgreSQL → versioned SQL → Next.js backend → public dashboard`

The browser never receives database credentials. Server-side queries in
[`sql/v1`](./sql/v1) calculate current network totals, the
active-user series, weekly usage, per-relayer and per-client breakdowns, and the
client deployment log. The backend keeps a completed snapshot for 60 seconds
to avoid querying the index database for every public page view.

Blokli already stores the indexed history, so the dashboard does not duplicate
events in another datastore. If `RPC_URL` is configured, the backend samples a
handful of anchor blocks with `eth_getBlockByNumber` and interpolates between
them; Gnosis produces blocks on a steady five-second cadence, so this lands
within seconds of the true timestamp without asking the RPC for tens of
thousands of blocks. Without `RPC_URL`, the same cadence is assumed outright and
dates are marked as estimated.

Only the summary query is required. The remaining queries degrade
independently, so a single unavailable relation empties one panel rather than
blanking the dashboard.

## Configuration

Copy `.env.example` to `.env.local` for local development:

```dotenv
DATABASE_URL=postgresql://dashboard:change-me@blokli-db:5432/blokli
# Optional
RPC_URL=https://rpc.gnosischain.com
```

- `DATABASE_URL` is required and currently supports PostgreSQL Blokli indexes.
  Use a dedicated read-only database role.
- `RPC_URL` is optional. Set it to anchor the historical charts to real block
  timestamps instead of an assumed block cadence.

## Run

Node.js 22.13 or newer is required.

```bash
npm ci
npm run dev
```

For production:

```bash
npm run build
npm start
```

The JSON representation of the current snapshot is available at
`/api/v1/dashboard`; it returns HTTP 503 when the database cannot be reached.
Kubernetes can use `/api/health/live` for liveness and `/api/health/ready` for
readiness. Readiness checks the cached analytics snapshot and returns HTTP 503
when the index database is unavailable.

## Container publishing

The `Publish container` GitHub Actions workflow builds and publishes
`ghcr.io/jeandemeusy/bloklune` whenever `main` or a `v*` tag is pushed. Every
build receives an immutable `sha-<full-commit-sha>` tag; version tags and the
mutable `main` convenience tag are also published.

## Metric definitions

Every published figure is reconstructed from chain events. No number on the page
is self-reported.

**Client traffic only.** This is a dashboard about the VPN, so it counts what VPN
clients did. Relays announce themselves on chain; an account that never announced
is not infrastructure, so a channel it opened is a client paying for its own
sessions. Every metric below is restricted to those channels — channels sourced
by announced accounts are relay-to-relay hops, not client usage.

**Redemptions.** Blokli appends one `channel_state` row per on-chain channel
event, and `TicketRedeemed` is the only event that advances `ticket_index`. A row
whose ticket index exceeds its predecessor's (within the same channel epoch) is
therefore a redemption, and the increment is the number of tickets it settled.
See [`sql/v1/redemptions.sql`](./sql/v1/redemptions.sql).

**Active users.** A client is an account that bound a key (`account`, written from
`KeyBinding`) but never announced an address (`announcement`, written from
`AddressAnnouncement`). It is active in a window when it settled a redemption on
one of its channels inside that window, or when it was first deployed inside it —
so a new client registers on deployment rather than only once its first tickets
are redeemed. Windows are inclusive of both endpoints: 7 days is `day-6..day`,
30 days is `day-30..day`.

**Ticket parameters.** Ticket price and winning probability are both oracle values
that Blokli stores only at their latest setting, so each timeline is recovered by
decoding the oracle's own logs — `TicketPriceUpdated` and `WinProbUpdated` — from
the raw `log` table. Ticket value is the price divided by the winning probability — the face value of a
ticket with one remaining hop; a ticket issued earlier in a multi-hop path is worth
that times the remaining hop count (`hopr-impls/ticket-manager/src/factory.rs`).

**Data volume.** A ticket is issued per packet but only wins with probability `p`,
so a redeemed ticket stands in for `1/p` packets of 650 bytes. Each redemption
therefore accounts for `650 / (2^30 * p)` GB, with `p` the winning probability in
force at that redemption's block. Redemptions predating the first oracle update
have no probability on record and are excluded rather than guessed. Blokli keeps only
the current probability in `chain_info`, so the timeline is recovered by decoding
`WinProbUpdated` logs from the raw `log` table
([`sql/v1/win-prob-updates.sql`](./sql/v1/win-prob-updates.sql)); the 7-byte
encoding is decoded exactly as `WinningProbability::as_f64` does. When the log
table is not in this database the page falls back to the current probability and
says so in a banner.

These deliberately avoid the service registry: the `gvpn:exit` service type
requires migration `m006`, which is not present on every deployed index.

Queries are versioned under `sql/v1`. Change their definitions by introducing a
new version rather than silently rewriting previously published methodology.
