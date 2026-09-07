# Bloklune

A public, read-only investor dashboard powered by a Blokli index database. The
application is intentionally self-contained so it can live in a dedicated
repository and be deployed beside any Blokli instance.

## Data path

`Blokli PostgreSQL → versioned SQL → Next.js backend → public dashboard`

The browser never receives database credentials. Server-side queries in
[`sql/v1`](./sql/v1) calculate current network totals, the
active-user series, weekly usage, per-relayer and per-client breakdowns, and the
client deployment log. The backend keeps a completed snapshot for 60 seconds so a page view costs no
database work of its own. Concurrent requests arriving during a refresh share the
one in-flight run rather than each starting their own, and failures are cached for
10 seconds so an unreachable index database is not queried again on every request
while it is down. The cache lives in the process, so each replica holds its own.

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

The dashboard reads one or more Blokli index databases. Copy `.env.example` to
`.env.local` for local development.

```dotenv
NETWORKS='[
  {"id":"jura","label":"Jura","databaseUrl":"postgresql://dashboard:pw@jura-db:5432/blokli","rpcUrl":"https://rpc.gnosischain.com"},
  {"id":"dev","label":"Dev","databaseUrl":"postgresql://dashboard:pw@dev-db:5432/blokli"}
]'
```

- `id` is lowercase letters, digits and dashes, and must be unique. It appears in
  `/api/v1/dashboard?network=<id>` but never in the page itself.
- `label` is what the network selector shows. Defaults to the id.
- `databaseUrl` must be a PostgreSQL connection string. Use a read-only role.
- `rpcUrl` is optional and per network: set it to anchor that network's charts to
  real block timestamps instead of an assumed five-second cadence.
- `exits` is optional and per network: the addresses of that network's exit nodes.
  See below.

A malformed `NETWORKS` is reported rather than ignored — a silent fallback to one
network would hide a deployment mistake behind a plausible-looking dashboard.

### Exit addresses

Downstream volume can only be attributed if the exits are named. Nothing on chain
separates an exit from a relay — both announce — so the alternative is identifying
exits by elimination, and that breaks the moment an exit also relays for a client:
it joins the relay set, its return traffic is filed as probing, and downstream
understates itself with nothing on the page to show for it.

Name them per network:

```dotenv
NETWORKS='[
  {"id":"jura-prod","label":"Jura","databaseUrl":"postgresql://…",
   "exits":["0x64885d2d2bc9df7b415aac184e020c632d715dff",
            "0x12b78461da59e8317c61bd249ea0dea2aa9527de",
            "0x1062696f8eec5b71bfa6be7e52df1d7457428106",
            "0x00d7096439d1f731c73574adb7e4a9f3b7775326",
            "0xd8efe2ebe14c8cc193d5a9f5afd81276549fad67",
            "0xcd9d0e23cd999dfc0d1400d837f8e612dbbbdfaa",
            "0x7220cfe91f369bfe79f883c2891e97407d7a4d48"]},
  {"id":"jura-dev","label":"Dev","databaseUrl":"postgresql://…",
   "exits":["0xe686ade652a815e0e26803c1a795f9d65c82e06e",
            "0x7b2b69c52ec97907d7a3b2d2724ba92781b7def7",
            "0x7f25c474f26488b2e29343c881f0cdc0e6d02abd"]}
]'
```

Or set `EXITS` to a comma-separated list to apply the same exits to every network;
a network naming its own overrides it. Addresses are lowercased on read, so
checksummed input is fine. A malformed address throws rather than being skipped —
an exit dropped for a typo would take its traffic out of the downstream figure
silently.

Once they are named, any redemption from a known exit to a relay is downstream —
no correction is applied, because there is nothing left to guess. The page says
"measured" rather than "inferred" and drops the caveat from the chart notes.

With no exits configured anywhere the elimination heuristic runs instead: exits
are taken to be announced payers that never relay, and because every node probes
the network, a probe floor is estimated from relay-to-relay traffic and
subtracted. That is a real estimate with a real error bar, and the page says so.
`totals.gigabytesDownstreamRaw` and `totals.probeFloorGigabytes` expose what the
correction did.

`totals.exitsNamed` and `totals.exitsSeen` report how many exits are configured
and how many were actually observed paying a relay. Seen below named means some
have gone quiet — worth chasing, since their traffic is missing from the figure.

**Single network.** A lone `DATABASE_URL` (with optional `RPC_URL`) still works and
is read as one unnamed network, so an existing deployment needs no change. The
selector is hidden when only one network is configured.

## Networks in the UI

The selector switches between each network and **All networks**. Every view is
computed server-side and sent together, so switching is instant and costs no
further database work.

In the combined view:

- **Ticket price, winning probability and ticket value show nothing.** Each network
  runs its own oracles, so a single figure would be a fiction.
- **Everything else aggregates.** Volume is exact rather than approximate: each
  redemption is priced with its own network's winning probability at its own block
  before anything is summed, so networks that price traffic differently still add up
  correctly.
- **Participants are counted per network.** The same address on two networks is two
  clients, because the two chains are unrelated. User counts are a union over the
  trailing window, not a sum of the per-network counts.
- **A network that cannot be read is left out** of the totals and named in a warning,
  rather than taking the whole page down.

## Toolchain

The repository ships a Nix flake with Node 22 and `psql`. With direnv installed:

```bash
direnv allow
```

`nix fmt` formats the Nix; application code goes through `npm run format`, which
runs oxfmt with the project's own configuration. The shell loads on `cd` into the
directory, and `.env.local` (git-ignored) is
sourced for `DATABASE_URL`, `RPC_URL` and friends. Without direnv, `nix develop`
gives the same shell. Without Nix, install Node 22.13 or newer by hand.

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
`/api/v1/client?network=<id>&key=<client key>` returns one client's drill-down
record, which is excluded from the snapshot above: it holds one record per client
and would otherwise be most of the payload, for the one record a click needs.
Kubernetes can use `/api/health/live` for liveness and `/api/health/ready` for
readiness. Readiness checks the cached analytics snapshot and returns HTTP 503
when the index database is unavailable.

JSON responses are compressed (brotli, else gzip) when the caller accepts it,
which takes the full payload from roughly 750 KiB to 80 KiB. Next does not
compress route-handler responses itself, so this is done in `lib/http.ts` rather
than left to whatever fronts the container.

The page is rendered per request — it must not be prerendered at build time,
where there is no index database to read and it would bake a "database
connection pending" dashboard into the image. Because the snapshot behind it only
changes once a minute, it is served with `s-maxage=60`, so a CDN or ingress cache
can serve one render to every visitor inside that window. Without a shared cache
in front, every request renders.

## Container publishing

The image is built from the flake, so the container and the development shell
resolve the same pinned toolchain:

```bash
nix build .#container   # Linux only; dockerTools does not run on macOS
docker load < result
```

`nix build .#bloklune` produces the same application tree without wrapping it in
an image, and `result/bin/bloklune` runs it directly. Both use Next's standalone
output, so only the dependencies `next build` actually traced are shipped.

The `Publish container` workflow type-checks and lints every pull request, and on
a push to `main` or a `v*` tag builds the image and publishes it to
`ghcr.io/jeandemeusy/bloklune`. Every build receives an immutable
`sha-<full-commit-sha>` tag; version tags and the mutable `main` convenience tag
are also published.

## Working on the UI without a database

```bash
npm run dev:fixtures
```

`DASHBOARD_FIXTURES=1` makes `loadAnalytics` return a synthetic snapshot instead of
querying, so the whole page renders with no `DATABASE_URL`, no index database and no
deploy in the loop. The generator is seeded, so reloads produce identical numbers
and a styling change is the only thing that moves between two screenshots. It
deliberately produces a long relayer tail, a wide client spread and uneven daily
activity, since those are the shapes that break layouts.

`DASHBOARD_FIXTURES=degraded` serves the same data with the second network
reporting failed queries, which is the only way to see the unavailable and partial
tile states without breaking a real database.

The fixture fabricates the finished snapshot rather than exercising the aggregation
in `lib/analytics.ts`. It validates rendering only — never read agreement there as
evidence that the real derivations are correct.

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
therefore a redemption. The increment is _not_ the number of tickets redeemed: a
client numbers a ticket for every packet it sends, only winning tickets are
redeemed, and the contract advances the index past the winner to block replay —
so the jump swallows every losing ticket issued in between and estimates the
packets that redemption paid for. Exactly one ticket is redeemed per
redemption. See [`sql/v1/redemptions.sql`](./sql/v1/redemptions.sql).

**Active users.** A client is an account that bound a key (`account`, written from
`KeyBinding`) but never announced an address (`announcement`, written from
`AddressAnnouncement`). It is active in a window when a redemption landed on
one of its channels inside that window, or when it was first deployed inside it —
so a new client registers on deployment rather than only once its first tickets
are redeemed. Windows are inclusive of both endpoints: 7 days is `day-6..day`,
30 days is `day-30..day`. The series is plotted from 2026-01-01, matching the
published `start_day`; the trailing windows still read activity from before it.

**Ticket parameters.** Ticket price and winning probability are both oracle values
that Blokli stores only at their latest setting, so each timeline is recovered by
decoding the oracle's own logs — `TicketPriceUpdated` and `WinProbUpdated` — from
the raw `log` table, in one pass
([`sql/v1/oracle-updates.sql`](./sql/v1/oracle-updates.sql)). Ticket value is the price divided by the winning probability — the face value of a
ticket with one remaining hop; a ticket issued earlier in a multi-hop path is worth
that times the remaining hop count (`hopr-impls/ticket-manager/src/factory.rs`).

**Data volume.** A ticket is issued per packet but only wins with probability `p`,
so a redeemed ticket stands in for `1/p` packets of 650 bytes. Each redemption
therefore accounts for `650 / (2^30 * p)` GB, with `p` the winning probability in
force at that redemption's block. Redemptions predating the first oracle update
have no probability on record and are excluded rather than guessed. Blokli keeps only
the current probability in `chain_info`, so the timeline is recovered by decoding
`WinProbUpdated` logs from the raw `log` table
([`sql/v1/oracle-updates.sql`](./sql/v1/oracle-updates.sql)); the 7-byte
encoding is decoded exactly as `WinningProbability::as_f64` does. When the log
table is not in this database the page falls back to the current probability and
says so in a banner.

These deliberately avoid the service registry: the `gvpn:exit` service type
requires migration `m006`, which is not present on every deployed index.

Queries are versioned under `sql/v1`. Change their definitions by introducing a
new version rather than silently rewriting previously published methodology.

### Indexes the queries want

The dashboard connects with a read-only role and creates nothing, so these belong
to whoever runs the Blokli index. Without them the two heaviest queries still
work, they just read more than they need to:

```sql
CREATE INDEX ON channel_state (channel_id, published_block, published_tx_index, published_log_index);
CREATE INDEX ON announcement (account_id);
CREATE INDEX ON log (topics);
```

The first turns the redemption queries' per-channel window function into an index
scan instead of a sort. The second is probed once per channel to tell a client
from a relay. The third is what makes the oracle history a range scan rather than
a sequential read of the largest table in the schema — the queries match event
signatures as prefix ranges over `topics` specifically so that it can be used.
