# Arrakis

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

The classic page (`/classic`) is rendered per request — it must not be prerendered at build time,
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

`nix build .#arrakis` produces the same application tree without wrapping it in
an image, and `result/bin/arrakis` runs it directly. Both use Next's standalone
output, so only the dependencies `next build` actually traced are shipped.

The `Publish container` workflow type-checks and lints every pull request, and on
a push to `main` or a `v*` tag builds the image and publishes it to
`ghcr.io/jeandemeusy/arrakis`. Every build receives an immutable
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

## Query store

Saved, user-editable SQL is replacing the hardcoded queries in `sql/v1`. The
backend, the studio (the editor, below), and the charts and dashboards built on
saved queries are in place. The page drawn from `sql/v1` has moved to
`/classic`, for comparison, until it is removed.

### Navigation

`/` lists the dashboards, bundled ones first. The sidebar on the left links
Home, every dashboard — with the sections of the one on screen, highlighted as
you scroll — Queries, and Settings (Exits; Bundled dashboards for editors),
plus the style switch and the editing lock. It folds to icons (remembered per
browser) and becomes a drawer on narrow screens. `/dashboards` redirects home.

Two visual styles: **Editorial**, the default — a calm page of white cards with
thin borders and the system's sans, after Dune — and **Neubrutal**, outlined
and loud. Every colour, face and shape is a token in `app/globals.css`, with
the charts' palettes mirrored in `app/chart-theme.ts`. Controls and cards
share a handful of them — `--radius-control`, `--radius-card`, `--hover`,
`--pressed`, `--focus-ring`, `--shadow-pop` — so buttons, inputs, toggles,
menus, drawers and cards read the same on every page, and the neubrutal style
restates the same tokens as square corners, yellow and hard shadows.

### Studio

`/queries` lists saved queries and `/queries/<slug>` opens one; `/settings/networks`
manages exits. A query page is laid out the way Dune's is:

- under the title, chips say what the query is — slug, visibility, refresh,
  how it combines networks, when it last ran and how long it took (green when
  current, amber when stale, red when the last run failed) and its version —
  and each one that can change is the control that changes it;
- the **Query editor** card holds the SQL, the network, parameter values as
  chips (the gear opens their definitions), and **Run ▾**: run to preview, or
  run and store;
- the **Query results** card has one tab for the result (stored, or the
  preview of the last run), one per chart drawn from it, and **Versions**;
  **New chart** starts another;
- **About this query** on the right lists its description, the tables and
  fragments it reads, the queries that use it (for a fragment), the
  dashboards showing its charts, and its latest versions. It and the schema on
  the left fold away (remembered per browser); **⋯** holds fork and archive.

Anyone can read public queries and their stored results; the **Unlock
editing** link asks for the editor password, after which you can:

- write SQL with highlighting, completion of tables, columns, fragments and
  placeholders (type `{{` for those), Cmd/Ctrl+Enter to run, Cmd/Ctrl+S to save,
  Cmd/Ctrl+/ to comment lines; the schema on the left inserts at the cursor;
- run against one network or all of them, previewing up to 10,000 rows, with
  the database's own error message when it fails;
- declare parameters (or let it declare the `{{names}}` it finds), and give
  values for a run;
- save, which creates the next version with an optional note; compare any
  version with the draft and load it back; fork; archive;
- schedule a refresh, run and store a result now, and read the stored result
  and its status per network, or download it as CSV;
- turn the selected SQL into a fragment (**Selection to fragment**), which
  saves it and puts `{{> slug}}` in its place;
- see, on a fragment, every query that uses it — directly or through another
  fragment — and how many charts hang off each; editing its SQL says how many
  queries a save will rerun;
- add and remove exits, and see when each one last paid a relay;
- build charts on a query's stored result (a tab per chart), and arrange
  charts from any query on dashboards.

The editor is a highlighted `<textarea>` written for this repository rather
than an editor package, so the Nix `npmDepsHash` is untouched.

#### Trying it locally

```bash
npm run dev:db -- --demo     # a local PostgreSQL in ./.pgdata, with a demo index
npm run hash-password        # choose a password; prints its hash
```

Put the lines `dev:db` prints, and the hash, in `.env.local`:

```dotenv
APP_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/arrakis
NETWORKS='[{"id":"demo","label":"Demo","databaseUrl":"postgresql://blokli_reader@127.0.0.1:54329/blokli_demo"}]'
ARRAKIS_EDITOR_PASSWORD_HASH=scrypt:15:8:1:…
```

Then `npm run dev` and open <http://localhost:3000/>. (`dev` runs on
webpack, like `build`: in the Nix shell `node_modules` is symlinked into the
Nix store, outside the project, and Turbopack refuses to resolve `next` from
there.) Leave out
`--demo` and keep your own `NETWORKS` to query a real index instead; the role
in its `databaseUrl` must be read-only or the studio refuses to run against it.
`npm run dev:db -- stop` stops the database and `-- reset` deletes it.

Queries are stored, versioned and run by the application, against the same
Blokli databases, and **only ever read them**. Every query runs through one
path (`lib/query/runner.ts`) that enforces this three times over:

- **The role.** Before a network's first query, and every five minutes after,
  its role is checked for any way to write — superuser, CREATE on the database
  or a schema, INSERT/UPDATE/DELETE/TRUNCATE on any table. If it finds one,
  queries on that network are refused with a message naming the privilege.
- **The transaction.** Every run is `BEGIN READ ONLY`, with a time limit.
- **The statement.** The SQL becomes the body of `DECLARE … CURSOR FOR`, which
  only accepts a query, wrapped as a subquery, where a data-modifying CTE is a
  syntax error, and sent through the extended protocol, which refuses a second
  statement.

After every run the connection is reset with `DISCARD ALL` before it returns
to the pool, so nothing a query sets on its session — an advisory lock, a
`set_config` — outlives it. On PostgreSQL 14 and older, `public` grants CREATE
to everyone by default; revoke it (`REVOKE CREATE ON SCHEMA public FROM
PUBLIC`) or the role check will refuse the network.

`queryDatabaseUrl` on a network (or `QUERY_DATABASE_URL` for a single one)
sends saved queries to a different connection — a read replica, say — and
defaults to `databaseUrl`.

### Configuration

```dotenv
APP_DATABASE_URL=postgresql://arrakis:…@app-db:5432/arrakis
ARRAKIS_EDITOR_PASSWORD_HASH=scrypt:15:8:1:…
```

`APP_DATABASE_URL` is the application's own database, separate from every
Blokli one. It holds the queries, their versions, the materialized results,
exit addresses and editor sessions, and the app migrates it itself on start
(`db/migrations`). Without it, none of this is enabled and the dashboard runs
exactly as before.

Editing is unlocked with a single password. Generate its hash with
`npm run hash-password` and set `ARRAKIS_EDITOR_PASSWORD_HASH`; the password
itself is never stored. Changing the variable and restarting rotates it;
unsetting it disables editing and ends every session. Underneath, it is one
`editor` account in a `users` table — sessions, authorship and rate limiting
all key on a user — so more editors are more rows, not a redesign.

Sessions are `HttpOnly`, `SameSite=Strict` cookies (`__Host-` and `Secure` in
production) backed by the database, so every replica honours them. Ten failed
logins from one address, or two hundred from everywhere, in 15 minutes locks
logins for 15 minutes. State-changing requests from another origin are
refused; set `ARRAKIS_ALLOWED_ORIGINS` if the editor is served from a second
hostname.

### Writing queries

Saved queries are SQL with a few placeholders, only recognized outside
strings and comments:

| Placeholder | Becomes |
|---|---|
| `{{name}}` | A declared parameter, bound as `$n::type` — never pasted into the SQL. Types: `text`, `integer`, `number`, `boolean`, `date`, `timestamp`, `address`, `text[]`, `integer[]`, `address[]`, `enum`. |
| `{{network}}` | The id of the network the query is running on. |
| `{{exits}}` | The exits configured for that network, as `bytea[]`. |
| `{{> slug}}` | Another saved query of kind `fragment`, inlined in parentheses: `FROM {{> client-channels}} AS c`, `WITH c AS {{> client-channels}}`, or — for an expression fragment — `SELECT {{> hex(address)}}`. |
| `{{> slug(a, name => b)}}` | A fragment with arguments, given in order or by name. Each argument is an SQL expression, inlined in parentheses; it cannot contain `{{`, but `$name` passes on an argument of the fragment it is written in. |
| `{{$name}}`, `{{$name = default}}` | Inside a fragment: an argument. A fragment run on its own uses the default, or `NULL`. |
| `{{block_time(expr)}}` | The `timestamptz` of block `expr`, interpolated between anchor blocks timestamped over `rpcUrl` — or, without one, from the five-second cadence, in which case the result says `"timebase": "estimated"`. Sessions run in UTC, so `::date` is a UTC day. |

`$1`-style parameters and a second statement are rejected before anything runs.

**Fragments** are reusable SQL. One that is a query (it starts with `SELECT`,
`WITH`, `VALUES` or `TABLE`) stands in for a table; anything else is an
expression and stands in for a value, so the same mechanism covers a shared
population (`vpn-clients`) and a shared formula (`uint256(balance)`). An
expression fragment run on its own is run as `SELECT (…) AS value`, with its
defaults. A fragment cannot use itself, directly or not.

**Versions are immutable.** Saving SQL creates the next version; nothing edits
one in place, including a hand-written `UPDATE`, which a trigger refuses.
Archiving a query hides it but keeps its history.

**Results are materialized.** Running a saved query copies its rows into a
table of their own in the app database, in the `results` schema. Reading a
result never runs the query, and many charts can aggregate one result without
touching Blokli again. A result records which fragment versions and which exit
set produced it; when either changes, the result is reported `stale` and the
scheduler reruns it.

**Scheduling.** A query with `refreshSeconds` (60 or more) is rerun on that
interval, and within one scheduler tick (10 s) of its inputs changing — a new
version, a new fragment version, a different exit set. One replica leads, through an
advisory lock in the app database; the others take over if it goes away. A
failed run keeps the previous result serving and records the error on it.

### Charts and dashboards

One query, one stored result, any number of charts. A chart never reads Blokli:
it shapes the stored rows, the server turns that into one SQL statement over
the result table, and the chart type draws what comes out.

Each chart is a tab of its query. The chart sits on top, full width, redrawn
as you change things, with the rows behind it a click away; under it, panels
say what it shows and how it is drawn:

- **Result data** — what the chart shows (below);
- **Chart options** — legend, stacking, normalize to percentage, total in the
  tooltip, data labels, lines drawn as steps, and *keep series colours
  stable*: colour each series by its name rather than its position, so a relay
  keeps its colour across charts and as others come and go;
- **X-axis options** — a title, reversed order, and a range selector under the
  chart to zoom into part of it;
- **Y-axis options** — a title, logarithmic scale, whether to include 0, a
  minimum and maximum, and the tick format; a second panel for the right axis
  once a series is on it;
- **Series** — one row per series as drawn: rename it, draw it as columns, a
  line or an area whatever the chart type (a line over bars), put it on the
  right axis, pick its colour (the style's swatches or any colour), hide it, or
  drag it to reorder. *Restore colours* drops the picked ones. All of it is
  saved by series name, so it follows a series however the data changes.

On a dashboard, clicking a legend entry hides that series for the moment, and
*All* toggles them together. A share chart's labels are its series: they take
the same names, colours and hiding.

**New chart** offers starting points built from the query's own columns —
trend over time, single number, top 10, breakdown over time, hour × weekday,
table of rows. What a chart shows is described in one of three ways:

- **Simple**, as a sentence: *show* a count, sum, average or distinct count,
  *over* a column (a time column by hour, day, week, month, or day or week
  depending on the range), *split* into series by another, for the *rows*
  within the dashboard's range (or a fixed window) and matching some filters —
  against a value, with the column's common values offered, or a dashboard
  variable. *More* adds a trailing window (distinct users over the last 30
  days, every day), top N, share of the total, a rank, filters on the results,
  order and a limit. The axes follow from what you chose
  ([`lib/viz/builder.ts`](./lib/viz/builder.ts) compiles it to steps).
- **Steps**, the pipeline below, for what the simple form cannot say; a simple
  chart turns into its steps in one click.
- **SQL** over the stored result, below.

While editing, a filter on an unset dashboard variable is previewed with the
column's most common value, so the chart draws at once.

| Step | Does |
|---|---|
| Filter | `=`, `!=`, `<`…, `contains`, `in`, null checks; against a value or a dashboard variable, optionally skipped while the variable is unset. |
| Range | Keeps the trailing `7d`, `30d`, `12h`, `6m`… named by a variable (default `range`) or fixed in the step, counted back from the newest row or from now; `all` keeps everything. |
| Bucket | A time to its hour, day, week or month, or to hour-of-day and day-of-week; or *day or week, by range* — daily up to 31 days, weekly beyond. |
| Compute | `+ − × ÷` between columns or with a number; days or months between two dates. |
| Window | `min`, `max`, `sum`, `count`, `first_value`, `row_number`, `rank` over partitions, as a new column — first-seen months for cohorts, say. |
| Group and aggregate | `count`, `count distinct` (of one column or a combination), `sum`, `avg`, `min`, `max`. |
| Rolling window | The same measures over the trailing N days at every date, optionally filling dates with no rows — distinct users over a week, every day. |
| Top N + others | Keeps the N largest categories and folds the rest into one. |
| Sort, Limit | |

Every column a step names is checked against what the previous step produced,
so a broken step says which column is missing and which exist. Values are
bound, never pasted into the SQL. Charts are cached for a minute, keyed by the
result tables they read, so a refresh shows straight away.

Chart types: number, line, area, bar (stacked or not, split by a column),
share, heatmap (hour × weekday fills every slot), cohort grid, and table. They
draw with the dashboard's own tiles and palettes, in both visual styles. A
tile names the chart and, muted beside it, the query it comes from; a number
sizes itself to the tile; and its footer says how fresh the stored result is
(green, amber when its query changed since, red when the last run failed),
with a **⋯** menu to open the query, download (the image, or the data), or
enlarge it.

Changing a variable switches its control at once and changes the address
without reloading the page. Each chart that reads the variable says
*Updating…* (fading a little) until its new data arrives; the others are left
alone, and only charts whose data changed are redrawn. The page also asks
`/api/v1/dashboards/<slug>/status` every 20 seconds (every 3 while something
runs) which of its queries are running: their charts say *Running…*, and
redraw on their own when the run finishes.

For anything the steps do not cover, a chart can be **SQL** over `{{result}}`
(and `{{name}}` for a dashboard variable, bound as text). It runs read-only, in
ten seconds at most, as `arrakis_results_reader`: a role that can read result
tables and nothing else in the app database. The migration creates that role
when the app's database user may (`CREATEROLE`, or a superuser such as the one
`npm run dev:db` uses); otherwise SQL charts are refused with a message and step
charts are unaffected. To set it up by hand:

```sql
CREATE ROLE arrakis_results_reader NOLOGIN;
GRANT arrakis_results_reader TO <app user> WITH SET TRUE;   -- PostgreSQL 16+
GRANT USAGE ON SCHEMA results TO arrakis_results_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA results TO arrakis_results_reader;
```

A **dashboard** is a grid of charts and headings, in order, each 1 to 12 columns
wide. **Edit** turns the page into its own editor:

- a bar floats at the top with *Add chart* (any chart saved on a query, found
  as you type), *Heading*, *Variables*, *Settings* (visibility, archive), and
  *Cancel* / *Save*, with a dot that turns amber once something changed;
- the title, description and headings are edited where they are shown;
- hovering a tile shows its tools: a grip to drag it elsewhere (a bar shows
  where it will land; with the grip focused, the arrow keys move it), its
  settings — title, note, what a click sets, when it shows — in a drawer on
  the right, and remove;
- drag a tile's bottom-right corner to resize it (or its right or bottom edge
  for one direction): the width snaps to twelfths of the grid, whose columns
  show faintly while editing, and the height to 40px steps, from 80 to 1200;
  the tile redraws as you drag, and the arrow keys do the same on a focused
  grip. Its **variables** are what viewers change: a time range, a network, or a
text variable such as a selected client. A chart reads them through its steps,
and a widget can be linked so that clicking a row or bar sets a variable here or
on another dashboard, and can be shown only while a variable is set — which is
how a drill-down works. Variables travel in the address
(`/dashboards/usage?range=7d&client=0x…`), so any view can be linked to.
Dashboards are private, unlisted or public, like queries. Every chart's title
(and *Open the query* in its menu) opens the query it is drawn from, on that
chart's tab — `/queries/<slug>?tab=charts&chart=<id>` — so any figure can be
traced to its SQL; charts on a private query only link for editors.

### The Gnosis VPN dashboard

The classic page (now at `/classic`) is being rebuilt from saved queries. The rebuilt version ships
as a bundle in [`db/seed/gnosis-vpn`](./db/seed/gnosis-vpn) (the SQL) and
[`lib/seed/gnosis-vpn.ts`](./lib/seed/gnosis-vpn.ts) (the charts and layout):
eight fragments, seven scheduled queries, about thirty charts, and two
dashboards — `gnosis-vpn`, and `gnosis-vpn-client`, the drill-down a client
row opens. Signed in, **Settings → Bundled dashboards → Install** writes all of it into the app
database; from then on it is edited in the studio like anything else, and
**Update** brings what it created back to the bundled version without
touching anything else. Its queries refresh every five minutes.

| Fragment | Is |
|---|---|
| `hex(value)` | bytes as `0x…` text |
| `uint256(value)` | a 32-byte big-endian integer as an exact `numeric` |
| `decode-win-prob(value)` | HOPR's 7-byte winning probability as a number from 0 to 1 |
| `vpn-nodes` | announced accounts: relays and exits |
| `vpn-clients` | accounts that never announced, with the block they were deployed in |
| `oracle-updates` | every winning-probability and ticket-price update, raw, from the logs |
| `vpn-redemptions` | every redemption that carried VPN traffic, with its direction |
| `win-probability` | the winning probability in force over each range of blocks |

| Query | One row per | Feeds |
|---|---|---|
| `vpn-traffic` | VPN redemption, upstream or downstream, dated and priced | volume, redemptions, hours, relays, client ranking, client record |
| `client-activity` | client and day it was active or deployed | active users, new vs returning, cohorts |
| `client-deployments` | client deployment | new clients, deployments table |
| `recent-redemptions` | one of the 500 newest client redemptions | redemption feed |
| `network-state` | — (one row) | active channels and balances |
| `ticket-parameters` | — (one row, per network only) | winning probability, price, value |
| `indexed-contracts` | contract | contracts table |

Exits must be configured on the **Exits** page (`/settings/networks`, under Settings in the sidebar): downstream is what they pay,
and with none configured there is none — nothing is guessed. A month is 31
days (today and the thirty before), as the old page and the Dune queries
count it; the range is a dashboard variable, so that is one edit away.

**Parity.** `npm run parity` checks the bundle against the page it replaces,
on your networks: it installs the bundle if needed, runs its queries, builds
the old snapshot from the same index at the same moment, with the same exits
and the same block clock, and compares every figure — the headline numbers at
every range, every point of every series, each heatmap cell, the cohort grid,
the client ranking, the tables and a few clients' records. It prints one line
per figure and exits 1 if anything differs. The few deliberate changes are
reported as such: the relay panels and daily users used to stop at 90 days
even on "all time", and the 90-day volume chart kept its first week whole.

```bash
npm run parity                     # each network, then all of them together
npm run parity -- --network jura   # one view
npm run parity -- --install        # update the installed bundle first
```

For a realistic local network, `npm run dev:db -- --demo` now loads
[`test/fixtures/blokli-demo.sql`](./test/fixtures/blokli-demo.sql): eleven
months of a generated network — growing deployments, daytime traffic, churn,
three exits, probing, changing oracle values. (`npm run dev:db -- reset` first
if you created the demo database before.) It prints the three exit addresses
to add on the Exits page.

### Exits

Exit addresses are configured per network on the Exits page,
`/settings/networks` (or through the API) and stored in the app database. A removal is recorded rather than
deleted, so the history of what was counted as downstream stays on record.
Adding an address that never announced on that network is allowed, with a
warning. Queries see them only as `{{exits}}`; with none configured, nothing is
guessed. `EXITS` and the per-network `exits` field still feed the current page
until it is rebuilt from saved queries, and are then removed.

### API

Reads are public for `public` and `unlisted` queries; `private` ones answer 404
unless signed in. Everything that runs SQL ad hoc or changes state requires a
session.

| Route | |
|---|---|
| `POST /api/v1/auth/login` `{password}` · `POST /api/v1/auth/logout` · `GET /api/v1/auth/session` | Sign in and out. |
| `GET /api/v1/networks` | Network ids and labels. |
| `GET·POST /api/v1/networks/:id/exits` · `DELETE …/exits/:address` | Exits; reading is public. |
| `GET /api/v1/schema?network=` | Tables and columns the role can read. |
| `POST /api/v1/run` `{sql, parameters?, values?, network?}` | Run unsaved SQL; up to 10,000 rows, nothing stored. |
| `GET·POST /api/v1/queries` | List, create. |
| `GET·PATCH·DELETE /api/v1/queries/:slug` | Read, change metadata, archive. |
| `GET·POST /api/v1/queries/:slug/versions` | History, save new SQL. |
| `POST /api/v1/queries/:slug/fork` `{slug, title?}` | Private copy. |
| `POST /api/v1/queries/:slug/run` `{network?, values?}` | Run now and store the result. |
| `GET /api/v1/queries/:slug/results?network=&limit=&offset=&p.name=` | The stored result. Never runs anything. |
| `GET·POST /api/v1/queries/:slug/visualizations` | Charts on a query. |
| `GET /api/v1/visualizations` · `GET·PATCH·DELETE /api/v1/visualizations/:id` | All charts; one chart. |
| `GET /api/v1/visualizations/:id/data?network=&v.name=` | A chart's rows, from stored results. |
| `POST /api/v1/visualizations/preview` `{query, config, network?, vars?}` | Rows for an unsaved chart. |
| `GET·POST /api/v1/dashboards` · `GET·PATCH·DELETE /api/v1/dashboards/:slug` | Dashboards. |
| `PUT /api/v1/dashboards/:slug/widgets` `{widgets: [...]}` | Replace the layout. |
| `GET /api/v1/dashboards/:slug/data?v.name=` | Every widget's rows in one call. |

`network=all` (the default where accepted) stacks every network's rows under a
leading `network` column; a query with `combine: "hidden"` has no such view.
Charts always see a `network` column, even for one network, so a chart that
counts or splits by network works whichever network a viewer picks.

| | |
|---|---|
| `GET /api/v1/bundles` · `POST /api/v1/bundles` `{name}` | Bundled dashboards; install or update one. |

### Tests

```bash
TEST_ADMIN_DATABASE_URL=postgresql://postgres:…@localhost/postgres npm test
```

The integration suite builds throwaway databases from
[`test/fixtures/blokli.sql`](./test/fixtures/blokli.sql) using that superuser
connection, and is skipped without it. The parity suite generates two networks
from [`blokli-demo.sql`](./test/fixtures/blokli-demo.sql) and requires the
bundled dashboard to match the old snapshot on each and on both combined. Node 22.18 or newer runs the TypeScript
directly; nothing else is needed.

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
