# Arrakis

Query a database in SQL, keep the answers as charts, and arrange the charts on
dashboards — for anyone to read, with each figure traceable to the SQL behind
it.

Arrakis connects to any PostgreSQL database, or one that speaks its protocol
(Supabase, Neon, RDS/Aurora, Timescale, AlloyDB…), through a role that can only
read. It keeps its own state — queries, their versions, stored results, charts,
dashboards, sessions — in a database of its own.

## How it works

`data source → saved, versioned SQL → stored result → charts → dashboards`

- **Queries** are SQL with a few placeholders, saved and versioned. Running one
  and storing it copies its rows into Arrakis's own database: its *stored
  result*. A schedule refreshes it.
- **Charts** shape a stored result — count, bucket by day, split into series —
  and never read the data source, so a dashboard stays fast however heavy the
  SQL behind it.
- **Dashboards** arrange charts from any queries, with variables (a time range,
  a data source, a selected value) that viewers change.
- **Bundles** carry a dashboard, its charts and its queries to another Arrakis
  as one file.

Everyone can read what is public; editing needs the editor password. The
in-app **Guide** (`/guide`) explains all of it to users; this file is for
whoever deploys and develops it.

## Quick start

```bash
npm ci
npm run dev:db -- --blokli   # a local PostgreSQL, with a made-up Blokli index to query
npm run hash-password        # choose the editor password; prints its hash
```

Put what `dev:db` prints, and the hash, in `.env.local`:

```dotenv
APP_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/arrakis
DATA_SOURCES='[{"id":"demo","label":"Demo","databaseUrl":"postgresql://blokli_reader@127.0.0.1:54329/blokli_demo"}]'
ARRAKIS_EDITOR_PASSWORD_HASH=scrypt:15:8:1:…
```

Then `npm run dev`, open <http://localhost:3000/>, unlock editing, import
[`examples/bundles/gnosis-vpn.json`](./examples/bundles/gnosis-vpn.json) under
**Settings → Bundles** for ready-made dashboards, and add the three exit
addresses `dev:db` printed to the list `exits` under **Settings → Lists**.
`--blokli` rebuilds the demo index each time it is given, dated up to today.
`npm run dev:db -- stop` stops the database and `-- reset` deletes it.

(`dev` runs on webpack, like `build`: in the Nix shell `node_modules` is
symlinked into the Nix store, outside the project, and Turbopack refuses to
resolve `next` from there.)

## Configuration

Data sources are configured in the deployment, not in the app.

```dotenv
DATA_SOURCES='[
  {"id":"prod","label":"Production","databaseUrl":"postgresql://reader:…@db:5432/app"},
  {"id":"staging","label":"Staging","databaseUrl":"postgresql://reader:…@staging-db:5432/app",
   "queryDatabaseUrl":"postgresql://reader:…@staging-replica:5432/app"}
]'
APP_DATABASE_URL=postgresql://arrakis:…@app-db:5432/arrakis
ARRAKIS_EDITOR_PASSWORD_HASH=scrypt:15:8:1:…
```

- `id` is lowercase letters, digits and dashes, unique; `label` is what the
  pickers show.
- `databaseUrl` is a PostgreSQL connection string, for a **read-only** role
  (below). `queryDatabaseUrl`, optional, is where saved queries actually run —
  a read replica, say.
- A lone `DATABASE_URL` (and `QUERY_DATABASE_URL`) still works, as one source.
  `NETWORKS`, this variable's former name, is read as `DATA_SOURCES`.
- A malformed `DATA_SOURCES` is reported rather than ignored: a silent fallback
  would hide a deployment mistake behind empty dashboards.

`APP_DATABASE_URL` is Arrakis's own database, separate from every data source.
The app migrates it itself on start (`db/migrations`). Without it, there is
nothing to save queries in and the studio says so.

Editing is unlocked with one password: `npm run hash-password` prints the hash
to put in `ARRAKIS_EDITOR_PASSWORD_HASH`; the password itself is never stored.
Changing the variable and restarting rotates it; unsetting it disables editing
and ends every session. Underneath it is one `editor` account in a `users`
table — sessions, authorship and rate limiting all key on a user — so more
editors are more rows, not a redesign.

Sessions are `HttpOnly`, `SameSite=Strict` cookies (`__Host-` and `Secure` in
production) backed by the database, so every replica honours them. Ten failed
logins from one address, or two hundred from everywhere, in 15 minutes locks
logins for 15 minutes. State-changing requests from another origin are refused;
set `ARRAKIS_ALLOWED_ORIGINS` if the studio is served from a second hostname.
Every response carries a Content Security Policy (scripts, styles, images and
requests from the app's own origin only; no framing), `nosniff`, a strict
referrer policy, `Cross-Origin-Opener-Policy` and, in production, HSTS
(`next.config.ts`).

### Run limits

| Variable | Default | |
|---|---|---|
| `ARRAKIS_QUERY_TIMEOUT_MS` | `30000` | Time limit of a preview (an unsaved run). |
| `ARRAKIS_MATERIALIZE_TIMEOUT_MS` | `120000` | Time limit of a stored run, by hand or scheduled. |
| `ARRAKIS_QUERY_TIMEOUT_MAX_MS` | `600000` | Ceiling on any query's own time limit. |
| `ARRAKIS_RESULT_ROW_LIMIT` | `5000000` | Most rows a stored result keeps; past it the result is marked cut. |
| `ARRAKIS_SCHEDULER_CONCURRENCY` | `2` | Scheduled refreshes running at once, across every data source. |

A query can set its own time limit and row cap under *Run limits* in its About
panel; the server's ceilings above still apply. A run past its limit answers
`408` with `details.timedOut`.

Every run holding a connection to a data source is listed in `active_runs`
with its backend pid, and shown under **Settings → Running now**, where an
editor can cancel it. Cancelling calls `pg_cancel_backend` with the same
read-only role, so it stops in the database at once, from any replica; the
cancelled run answers `409` with `details.cancelled`. The workbench's *Run*
button turns into *Cancel* while a preview runs, and *Run and store* into
*Cancel run*. Rows left behind by a crashed process are pruned after two hours.

### Read-only, three times over

Queries are stored, versioned and run by the application, against your data
sources, and **only ever read them**. Every query runs through one
path (`lib/query/runner.ts`) that enforces this three times over:

- **The role.** Before a data source's first query, and every five minutes after,
  its role is checked for any way to write — superuser, CREATE on the database
  or a schema, INSERT/UPDATE/DELETE/TRUNCATE on any table. If it finds one,
  queries on that source are refused with a message naming the privilege.
- **The transaction.** Every run is `BEGIN READ ONLY`, with a time limit.
- **The statement.** The SQL becomes the body of `DECLARE … CURSOR FOR`, which
  only accepts a query, wrapped as a subquery, where a data-modifying CTE is a
  syntax error, and sent through the extended protocol, which refuses a second
  statement.

After every run the connection is reset with `DISCARD ALL` before it returns
to the pool, so nothing a query sets on its session — an advisory lock, a
`set_config` — outlives it. On PostgreSQL 14 and older, `public` grants CREATE
to everyone by default; revoke it (`REVOKE CREATE ON SCHEMA public FROM
PUBLIC`) or the role check will refuse the source.

`queryDatabaseUrl` on a data source (or `QUERY_DATABASE_URL` for a single one)
sends saved queries to a different connection — a read replica, say — and
defaults to `databaseUrl`.

## Using it

### Writing queries

Saved queries are SQL with a few placeholders, recognized only outside strings
and comments:

| Placeholder | Becomes |
|---|---|
| `{{name}}` | A declared parameter, bound as `$n::type` — never pasted into the SQL. Types: `text`, `integer`, `number`, `boolean`, `date`, `timestamp`, `address`, `text[]`, `integer[]`, `address[]`, `enum`. |
| `{{list:name}}` | A list kept under Settings → Lists, as an array of its type (`text[]`, `numeric[]`, `bytea[]`): the values kept for the data source the run reads, and those kept for all of them. |
| `{{source}}` | The id of the data source the run reads (also `{{network}}`). |
| `{{> slug}}` | Another saved query of kind `fragment`, inlined in parentheses: `FROM {{> paid-orders}} AS o`, `WITH o AS {{> paid-orders}}`, or — for an expression fragment — `SELECT {{> cents(amount)}}`. |
| `{{> slug(a, name => b)}}` | A fragment with arguments, given in order or by name. Each argument is an SQL expression, inlined in parentheses; it cannot contain `{{`, but `$name` passes on an argument of the fragment it is written in. |
| `{{$name}}`, `{{$name = default}}` | Inside a fragment: an argument. A fragment run on its own uses the default, or `NULL`. |

`$1`-style parameters and a second statement are rejected before anything runs.
`{{exits}}`, from before lists existed, still reads the list named `exits`.

**Fragments** are reusable SQL. One that is a query (it starts with `SELECT`,
`WITH`, `VALUES` or `TABLE`) stands in for a table; anything else is an
expression and stands in for a value, so the same mechanism covers a shared
population and a shared formula. A fragment cannot use itself, directly or not.

**Lists** keep values out of the SQL, so editors change them without a new
version: the accounts to leave out, the regions that count. Each value belongs
to one data source or to every one. A list's values are part of each stored
result's inputs: changing them makes the results of the queries that read it
stale, and the scheduler reruns those. Removals are recorded, not deleted.

**Versions are immutable.** Saving SQL creates the next version; nothing edits
one in place, including a hand-written `UPDATE`, which a trigger refuses.
Archiving a query hides it but keeps its history.

**Results are materialized** into tables of their own in the app database, in
the `results` schema. Reading a result never runs the query. A result records
which fragment versions and list values produced it; when either changes, it is
reported `stale`.

**Scheduling.** A query with `refreshSeconds` (60 or more) is rerun on that
interval, and within one scheduler tick (10 s) of its inputs changing. One
replica leads, through an advisory lock in the app database; the others take
over if it goes away. A failed run keeps the previous result serving and
records the error on it. At most `ARRAKIS_SCHEDULER_CONCURRENCY` scheduled runs
are in flight at once.

**Several data sources.** A query runs on one, or on all of them with their
rows stacked under a `network` column — useful when they share a schema, like
production and staging. A query whose figure only means something per source
sets `combine: "hidden"`. A dashboard's data source variable decides whether
viewers may pick *All, stacked*.

In the editor: highlighting, completion of tables, columns, fragments, lists and
placeholders (type `{{`), Cmd/Ctrl+Enter to run (the selection only, when there
is one), Cmd/Ctrl+S to save, Cmd/Ctrl+/ to comment lines, Shift+Alt+F to format
(an in-house formatter, [`app/(studio)/sql-format.ts`](./app/(studio)/sql-format.ts),
that changes only whitespace and the case of keywords), and **Explain** /
**Explain and measure** (`EXPLAIN ANALYZE`, in the same read-only transaction
and time limit) in the Run menu. The editor is a highlighted `<textarea>`
written for this repository rather than an editor package, so the Nix
`npmDepsHash` is untouched.

### Charts and dashboards

One query, one stored result, any number of charts. A chart never reads the data source:
it shapes the stored rows, the server turns that into one SQL statement over
the result table, and the chart type draws what comes out.

Each chart is a tab of its query. The chart sits on top, full width, redrawn
as you change things, with the rows behind it a click away; under it, panels
say what it shows and how it is drawn:

- **Result data** — what the chart shows (below);
- **Chart options** — legend, stacking, normalize to percentage, total in the
  tooltip, data labels, lines drawn as steps, and *keep series colours
  stable*: colour each series by its name rather than its position, so a category
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
table of rows, a donut of a category, and *columns and a line* (a count as
columns, a sum or distinct count as a line on the right axis). What a chart
shows is described in one of three ways:

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
| Range | Keeps the trailing `7d`, `30d`, `12h`, `6m`… of a time column, or the last `500000` of a number column such as a block, named by a variable (default `range`) or fixed in the step. A time window counts back from the newest row or from now; a number window from its newest value, or from a column holding where it ends (`head_block`). `all` keeps everything. |
| Bucket | A time to its hour, day, week or month, or to hour-of-day and day-of-week; or *day or week, by range* — daily up to 31 days, weekly beyond. A number into bins of a fixed width, or about forty round-width bins (1, 2 or 5 × 10ⁿ) over the window, each named by its start. |
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
share, pie (or a donut with the total in its middle; past ten slices the rest
fold into one), heatmap (hour × weekday fills every slot), cohort grid, and table. They
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
  grip. Its **variables** are what viewers change: a time range, a data source, or a
text variable such as a selected client. A chart reads them through its steps,
and a widget can be linked so that clicking a row or bar sets a variable here or
on another dashboard, and can be shown only while a variable is set — which is
how a drill-down works. Variables travel in the address
(`/dashboards/usage?range=7d&client=0x…`), so any view can be linked to.
Dashboards are private, unlisted or public, like queries. Every chart's title
(and *Open the query* in its menu) opens the query it is drawn from, on that
chart's tab — `/queries/<slug>?tab=charts&chart=<id>` — so any figure can be
traced to its SQL; charts on a private query only link for editors.

### Bundles

A bundle is a dashboard with everything it needs, as one JSON file: the
dashboard, those its charts link to, the charts, their queries, the fragments
those use, and the definitions of the lists they read (never the values, which
are each Arrakis's own). [`lib/bundles/format.ts`](./lib/bundles/format.ts)
describes the format.

- **Export:** an editor downloads one from a dashboard's **Share** menu
  (`GET /api/v1/dashboards/:slug/bundle`).
- **Import:** **Settings → Bundles**, from a file or an https URL. The server
  downloads URLs itself (the page's CSP keeps the browser to its own origin), so
  it only fetches https, from public addresses, at most 5 MB in 10 seconds,
  and checks every redirect again.
- **What it does:** the import first shows, item by item, what it would create,
  update or replace. Everything it creates is marked with the bundle's name, so
  importing a newer file of the same bundle updates what the last one created.
  A query or dashboard of the same slug that came from elsewhere is a conflict,
  overwritten only when asked (`replace`). Lists are created empty. What an
  earlier file created and the newer one no longer has is archived.
- **Removing one:** **Remove…** beside an imported bundle lists what it would
  archive, then archives its dashboards, charts and queries. Lists stay, values
  and all. Either way, something still used from outside the bundle is kept,
  with the reason: a fragment a query of yours inlines, a query a chart of yours
  reads, a chart on a dashboard of yours. Nothing is deleted: archived queries
  are under **Queries → Show archived**, and importing the bundle again brings
  everything back.

An example ships in [`examples/bundles`](./examples/bundles):
[`gnosis-vpn.json`](./examples/bundles/gnosis-vpn.json), the Gnosis VPN
dashboards for a Blokli index of the HOPR network (it reads the list `exits`).
They read the raw event log (Blokli's `log` table) and decode the events in
SQL; apart from that, only the last indexed block (`chain_info`) and the
contract list (`log_topic_info`) come from Blokli's own tables.

### Search, lineage, guide, sharing

Cmd/Ctrl+K searches dashboards, queries, charts, fragments, tables and the
guide. `/lineage` lays out tables → fragments → queries → charts → dashboards
and lights up what an item reads and what reads it; both read
`GET /api/v1/lineage` (tables for editors only, matched by name in each query's
own SQL). `/guide` explains the model, with a FAQ, and the **?** beside the
main controls links to its sections. **Share** on a dashboard or query gives
its link and sets who it opens for — editors only (private), anyone with the
link (unlisted) or everyone (public). The Editorial style follows the system's
light or dark setting, or a Light / Dark / System switch in the sidebar.

### API

Reads are public for `public` and `unlisted` queries; `private` ones answer 404
unless signed in. Everything that runs SQL ad hoc or changes state requires a
session.

| Route | |
|---|---|
| `POST /api/v1/auth/login` `{password}` · `POST /api/v1/auth/logout` · `GET /api/v1/auth/session` | Sign in and out. |
| `GET /api/v1/networks` | Data source ids and labels. |
| `GET·POST /api/v1/lists` · `PATCH·DELETE /api/v1/lists/:name` · `POST /api/v1/lists/:name/values` · `DELETE …/values/:id` | Lists and their values. Editors only. |
| `GET /api/v1/schema?network=` | Tables and columns the source's role can read. |
| `POST /api/v1/run` `{sql, parameters?, values?, network?, timeoutSeconds?, runKey?, explain?}` | Run unsaved SQL; up to 10,000 rows, nothing stored. `runKey` lets it be cancelled; `explain: "plan" \| "analyze"` returns the query plan instead. |
| `GET /api/v1/runs` · `POST /api/v1/runs/cancel` `{id \| runKey \| query}` | Runs in progress; cancel one, or every run of a query. |
| `GET /api/v1/lineage` | Tables (editors only), fragments, queries, charts and dashboards, and what reads what. |
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
| `GET /api/v1/dashboards/:slug/bundle` | The dashboard as a bundle file. Editors only. |
| `GET·POST /api/v1/bundles` `{bundle \| url, replace?}` · `POST /api/v1/bundles/preview` | Imported bundles; import one; what an import would do. |
| `GET·DELETE /api/v1/bundles/{name}` | What removing a bundle would archive and keep; remove it. |

In the API a data source is a `network` (the name it had first). `network=all`
(the default where accepted) stacks every source's rows under a leading
`network` column; a query with `combine: "hidden"` has no such view. Charts
always see a `network` column, even for one source, so a chart that counts or
splits by source works whichever one a viewer picks.

## Development

### Toolchain

The repository ships a Nix flake with Node 22 and `psql`. With direnv installed:

```bash
direnv allow
```

`nix fmt` formats the Nix; application code goes through `npm run format`, which
runs oxfmt with the project's own configuration. The shell loads on `cd` into the
directory, and `.env.local` (git-ignored) is
sourced for `DATA_SOURCES` and friends. Without direnv, `nix develop`
gives the same shell. Without Nix, install Node 22.13 or newer by hand.

### Build and run

```bash
npm run build && npm start
```

`/api/health/live` is for liveness; `/api/health/ready` answers 503 unless the
app database (when configured) and at least one data source answer.

### Tests

```bash
TEST_ADMIN_DATABASE_URL=postgresql://postgres:…@localhost/postgres npm test
```

The integration suite builds throwaway databases using that superuser
connection, and is skipped without it. Its data sources are loaded from
[`test/fixtures`](./test/fixtures): a Blokli-shaped index, which also lets it
run every query of the Gnosis VPN example bundle. Node 22.18 or newer runs the TypeScript
directly; nothing else is needed.

### Container publishing

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
