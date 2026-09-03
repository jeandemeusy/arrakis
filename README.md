# Gnosis VPN Network Intelligence

A public, read-only investor dashboard powered by a Blokli index database. The
application is intentionally self-contained so it can live in a dedicated
repository and be deployed beside any Blokli instance.

## Data path

`Blokli PostgreSQL → versioned SQL → Next.js backend → public dashboard`

The browser never receives database credentials. Server-side queries in
[`sql/v1`](./sql/v1) calculate current network totals, the
active-user series, weekly usage and the relayer distribution. The backend keeps a completed snapshot for 60 seconds
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

**Redemptions.** Blokli appends one `channel_state` row per on-chain channel
event, and `TicketRedeemed` is the only event that advances `ticket_index`. A row
whose ticket index exceeds its predecessor's (within the same channel epoch) is
therefore a redemption, and the drop in channel balance across that pair of rows
is what the relay was paid. See [`sql/v1/redemptions.sql`](./sql/v1/redemptions.sql).

**Active users.** An account is active in a window when it was the source of a
channel that saw a redemption inside the window, or when it announced inside the
window. The chart plots this per day over trailing 7- and 30-day windows.

**Data volume.** Each packet issues exactly one ticket priced at the network
ticket price, and a ticket's face value already carries the
1/winning-probability multiplier, so redeemed value divided by the indexed ticket
price is the expected number of packets paid for. Each packet carries 1,038
bytes of payload (`HoprPacket::PAYLOAD_SIZE`). Volume is counted once per paid
relay hop, so a packet crossing several paid hops contributes once per hop.

These deliberately avoid the service registry: the `gvpn:exit` service type
requires migration `m006`, which is not present on every deployed index.

Queries are versioned under `sql/v1`. Change their definitions by introducing a
new version rather than silently rewriting previously published methodology.
