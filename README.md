# Gnosis VPN Network Intelligence

A public, read-only investor dashboard powered by a Blokli index database. The
application is intentionally self-contained so it can live in a dedicated
repository and be deployed beside any Blokli instance.

## Data path

`Blokli PostgreSQL → versioned SQL → Next.js backend → public dashboard`

The browser never receives database credentials. Server-side queries in
[`sql/v1`](./sql/v1) calculate current network totals and the historical
ticket-redemption series. The backend keeps a completed snapshot for 60 seconds
to avoid querying the index database for every public page view.

Blokli already stores the indexed history, so the dashboard does not duplicate
events in another datastore. If `RPC_URL` is configured, the backend resolves
the relevant Gnosis Chain blocks with `eth_getBlockByNumber`, caches the
immutable block-to-timestamp mapping in memory, and renders weekly time buckets.
Without `RPC_URL`, the same chart uses block-number buckets.

## Configuration

Copy `.env.example` to `.env.local` for local development:

```dotenv
DATABASE_URL=postgresql://dashboard:change-me@blokli-db:5432/blokli
# Optional
RPC_URL=https://rpc.gnosischain.com
```

- `DATABASE_URL` is required and currently supports PostgreSQL Blokli indexes.
  Use a dedicated read-only database role.
- `RPC_URL` is optional. Set it to enable timestamp-based historical charts.

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

## Metric governance

Investor queries are versioned under `sql/v1`. Change their definitions by
introducing a new version rather than silently rewriting previously published
methodology. The reported `100+` user milestone is an external program KPI and
is visually separated from Blokli-derived on-chain participation.
