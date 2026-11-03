import type { Metadata } from 'next';
import Link from 'next/link';

import { GUIDE_TOPICS } from './topics';

export const metadata: Metadata = { title: 'Guide' };

/**
 * The guide: how Arrakis works, the placeholders queries can use, charts and
 * dashboards, and the questions that come up. Every section has an anchor,
 * which help tips and the search palette link to.
 */

function Section({
  id,
  children,
}: {
  id: (typeof GUIDE_TOPICS)[number]['id'];
  children: React.ReactNode;
}) {
  const entry = GUIDE_TOPICS.find((topic) => topic.id === id)!;
  return (
    <section id={id} className="guide-section">
      <h2>
        <a href={`#${id}`}>{entry.title}</a>
      </h2>
      {children}
    </section>
  );
}

function Question({
  question,
  children,
}: {
  question: string;
  children: React.ReactNode;
}) {
  return (
    <details className="guide-question">
      <summary>{question}</summary>
      <div>{children}</div>
    </details>
  );
}

export default function GuidePage() {
  return (
    <main className="studio-page guide-page">
      <header className="page-head">
        <div>
          <h1>Guide</h1>
          <p className="studio-muted">
            How Arrakis turns SQL into charts and dashboards, the placeholders a
            query can use, and answers to the questions that come up. Press{' '}
            <kbd>⌘K</kbd> anywhere to search.
          </p>
        </div>
      </header>

      <div className="guide-layout">
        <nav className="guide-toc" aria-label="Sections">
          <ol>
            {GUIDE_TOPICS.map((entry) => (
              <li key={entry.id}>
                <a href={`#${entry.id}`}>{entry.title}</a>
              </li>
            ))}
          </ol>
        </nav>

        <article className="guide-body">
          <Section id="start">
            <p>
              Arrakis is a place to ask questions of a database in SQL and keep
              the answers as charts. It connects to each data source through a
              read-only role, so nothing it runs can change the data.
            </p>
            <ol className="guide-flow">
              <li>
                <strong>Queries</strong> are SQL, saved and versioned. Running
                one and storing it copies its rows into Arrakis&apos;s own
                database: its <em>stored result</em>.
              </li>
              <li>
                <strong>Charts</strong> shape a stored result: count it, group
                it by day, split it into series. A chart never runs its query;
                it only reads the stored rows, which is why dashboards are fast
                however heavy the SQL behind them.
              </li>
              <li>
                <strong>Dashboards</strong> arrange charts from any queries on a
                grid, with <em>variables</em> (a range, a data source, a
                selected value) that viewers change.
              </li>
            </ol>
            <p>
              Anyone can read what is public. <strong>Unlock editing</strong> at
              the bottom of the sidebar asks for the editor password; after that
              you can write queries, build charts and arrange dashboards.
            </p>
            <p>
              The switches at the foot of the sidebar change how it looks: the
              calm <em>Editorial</em> style, light, dark or as your system is
              set, or the loud <em>Neubrutal</em> one.
            </p>
          </Section>

          <Section id="sources">
            <p>
              A data source is a PostgreSQL database, or one that speaks its
              protocol (Supabase, Neon, RDS, Timescale…). Arrakis reaches each
              through a role that can only read, and refuses one that can write.
              Sources are set where Arrakis is deployed, in{' '}
              <code>DATA_SOURCES</code>, not from this page.
            </p>
            <p>
              With several sources, a query runs on one, or on all of them with
              their rows stacked: useful when they share a schema, like
              production and staging. A query whose figure only means something
              per source can refuse the stacked view. A dashboard&apos;s data
              source variable decides whether its viewers may pick{' '}
              <em>All, stacked</em>. In dashboard editing, Variables also lets
              you choose which sources are selectable. Stacking then includes
              only those sources.
            </p>
          </Section>

          <Section id="queries">
            <p>
              Open <Link href="/queries">Queries</Link> and pick one, or start a{' '}
              <Link href="/queries/new">new query</Link>. The schema on the left
              lists the tables the read-only role can see; click a table or
              column to insert it at the cursor.
            </p>
            <ul>
              <li>
                <strong>Run</strong> previews the draft: up to 10,000 rows,
                nothing stored, nothing saved. Use it as often as you like.
              </li>
              <li>
                <strong>Save</strong> creates the next version, with an optional
                note. Versions are never edited in place; the <em>Versions</em>{' '}
                tab compares any of them with your draft.
              </li>
              <li>
                Select part of the SQL and Run becomes{' '}
                <strong>Run selection</strong>: only that part runs, a CTE body
                or a subquery, say, with the query&apos;s parameters.
              </li>
              <li>
                <strong>Run and store</strong> (the arrow beside Run) runs the
                saved version and replaces the stored result its charts read.
              </li>
              <li>
                <strong>Explain</strong>, in the same menu, shows how the
                database would run the query without running it;{' '}
                <strong>Explain and measure</strong> runs it and says where the
                time went. Start there when a query is slow.
              </li>
              <li>
                The wand above the editor <strong>formats</strong> the SQL: a
                clause per line, keywords in capitals. Only spacing and capitals
                change; undo puts it back.
              </li>
              <li>
                The chip under the title picks the data source a run reads, or
                all of them at once, stacked under a <code>network</code> column
                that names the source.
              </li>
            </ul>
            <p>
              A query is <em>private</em> (editors only), <em>unlisted</em>{' '}
              (anyone with the link) or <em>public</em>. Fork one to make your
              own copy; archive one to hide it while keeping its history.
            </p>
          </Section>

          <Section id="templates">
            <p>
              Queries are plain SQL plus a few placeholders in double braces.
              They are recognised only outside strings and comments, and values
              are always bound, never pasted into the SQL.
            </p>
            <table className="guide-table">
              <thead>
                <tr>
                  <th scope="col">Write</th>
                  <th scope="col">Becomes</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <code>{'{{name}}'}</code>
                  </td>
                  <td>
                    A declared <a href="#parameters">parameter</a>, bound as a
                    typed value.
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>{'{{> slug}}'}</code>
                  </td>
                  <td>
                    A <a href="#fragments">fragment</a>, inlined in parentheses:{' '}
                    <code>{'FROM {{> active-users}} AS u'}</code>.
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>{'{{> slug(a, name => b)}}'}</code>
                  </td>
                  <td>
                    A fragment with arguments, in order or by name. Each is an
                    SQL expression.
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>{'{{$name}}'}</code>, <code>{'{{$name = 0}}'}</code>
                  </td>
                  <td>
                    Inside a fragment: one of its arguments, with an optional
                    default.
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>{'{{list:name}}'}</code>
                  </td>
                  <td>
                    A <a href="#lists">list</a> kept under Settings → Lists, as
                    an array: <code>{'WHERE id = ANY({{list:excluded}})'}</code>
                    .
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>{'{{source}}'}</code>
                  </td>
                  <td>The id of the data source the run reads.</td>
                </tr>
              </tbody>
            </table>
            <p>
              Type <code>{'{{'}</code> in the editor to have them completed.
              Positional <code>$1</code> parameters and a second statement are
              refused before anything runs.
            </p>
          </Section>

          <Section id="parameters">
            <p>
              Write <code>{'{{min_amount}}'}</code> in the SQL and the editor
              offers to declare it. A parameter has a type (text, integer,
              number, boolean, date, timestamp, address, lists of those, or a
              fixed list of options), an optional default, and a value for the
              next run, set in the chips under the editor.
            </p>
            <p>
              Because it is bound as <code>$n::type</code>, a parameter can only
              ever be a value: it cannot change which table is read or add a
              condition. A stored result uses the defaults.
            </p>
          </Section>

          <Section id="fragments">
            <p>
              A fragment is SQL saved to be reused by other queries. One that is
              a query (it starts with <code>SELECT</code>, <code>WITH</code>,{' '}
              <code>VALUES</code> or <code>TABLE</code>) stands in for a table;
              anything else is an expression and stands in for a value. The same
              mechanism covers a shared population and a shared formula.
            </p>
            <p>
              Select SQL in the editor and choose{' '}
              <strong>Selection to fragment</strong> to save it as one and put
              its call in its place. A fragment&apos;s About panel lists every
              query that uses it; saving a new version marks their results
              stale, and the scheduled ones are rerun.
            </p>
          </Section>

          <Section id="lists">
            <p>
              A list is a set of values a query reads, kept out of its SQL so
              editors can change it without a new version: the accounts to leave
              out, the regions that count. Create one under{' '}
              <Link href="/settings/lists">Settings → Lists</Link> and write{' '}
              <code>{'{{list:name}}'}</code> where an array goes:{' '}
              <code>{'WHERE account = ANY({{list:excluded}})'}</code>.
            </p>
            <p>
              A list holds text, numbers or bytes (written <code>0x…</code>),
              and each value is kept for one data source or for every one.
              Changing a list makes the stored results of the queries that read
              it stale, and the scheduled ones rerun.
            </p>
          </Section>

          <Section id="results">
            <p>
              A stored result is a copy of the rows a query returned, kept until
              the next run. Charts read it; nothing reads the data source again
              until the query runs again. If a run fails, the previous result
              keeps serving and the error is recorded on it.
            </p>
            <p>
              The freshness chip under a query&apos;s title, and the footer of
              every chart, say how old the result is: green when current, amber
              when <em>stale</em> (the query, a fragment it uses or a list it
              reads changed since), red when the last run failed.
            </p>
            <p>
              A <strong>refresh</strong> schedule (hourly, daily…) reruns the
              query on that interval, and soon after it goes stale.
            </p>
          </Section>

          <Section id="limits">
            <p>
              Every run has a time limit: 30 seconds for a preview and 2 minutes
              for a stored run, unless the query sets its own under{' '}
              <em>Run limits</em> in its About panel. A run past its limit is
              stopped in the database and says so. A stored result also keeps at
              most a set number of rows; past it, it is marked as cut.
            </p>
            <p>
              While a preview runs, <strong>Run</strong> turns into{' '}
              <strong>Cancel</strong>. Every run in progress, previews, stored
              runs and scheduled refreshes, is listed under{' '}
              <Link href="/settings/runs">Settings → Running now</Link>, where
              an editor can cancel it.
            </p>
          </Section>

          <Section id="charts">
            <p>
              On a query&apos;s page, <strong>New chart</strong> offers starting
              points built from its columns: a trend over time, a single number,
              a top 10, a breakdown, an hour × weekday heatmap or a table. What
              the chart shows can then be described three ways:
            </p>
            <ul>
              <li>
                <strong>Simple</strong>, as a sentence: show a count, sum or
                average, over a time column, split by another, for the rows in
                the dashboard&apos;s range and matching some filters.
              </li>
              <li>
                <strong>Steps</strong>, a pipeline of filters, buckets,
                groupings, rolling windows and top-N, for what a sentence cannot
                say. A simple chart turns into its steps in one click.
              </li>
              <li>
                <strong>SQL</strong> over <code>{'{{result}}'}</code>, the
                stored rows, for anything else.
              </li>
            </ul>
            <p>
              Chart types: number, line, area, bar, share (horizontal bars), pie
              or donut, heatmap, cohort grid and table. A{' '}
              <em>Columns and a line</em> starting point draws a count as
              columns with a second measure as a line on its own axis; any
              series can be switched between columns, line and area the same
              way.
            </p>
            <p>
              The panels below the chart set the legend, stacking, axes and each
              series: its name, colour, whether it is a line, area or columns,
              and which axis it uses. Settings are kept by series name, so they
              follow a series however the data changes.
            </p>
          </Section>

          <Section id="dashboards">
            <p>
              A dashboard&apos;s <strong>variables</strong> are the controls
              across its top: a time range (or a range of blocks, over a block
              column), a data source, or a text value such as a selected
              account. A chart reads them through its filters and range step, so
              changing one redraws only the charts that read it. Variables
              travel in the address, so any view can be linked to.
            </p>
            <p>
              <strong>Edit</strong> turns the page into its own editor: add
              charts from any query, add headings, drag a tile by its grip to
              move it, drag its corner to resize it, and open its settings to
              rename it or make a click on it set a variable, here or on another
              dashboard. That is how a drill-down works: click a row, and a
              second dashboard opens filtered on it.
            </p>
          </Section>

          <Section id="bundles">
            <p>
              A bundle carries a dashboard to another Arrakis: the dashboard,
              those its charts link to, the charts, their queries, the fragments
              those use and the definitions of the lists they read (not the
              values, which are each Arrakis&apos;s own). An editor downloads
              one from a dashboard&apos;s <strong>Share</strong> menu.
            </p>
            <p>
              <Link href="/settings/bundles">Settings → Bundles</Link> imports
              one from a file or a URL. It first shows what it would create,
              update or replace; importing a newer file of the same bundle
              updates what the last import created. A query or dashboard of the
              same name that came from elsewhere is only overwritten when you
              say so. The queries then run on your data sources, so they must
              find the tables they expect there.
            </p>
            <p>
              <strong>Remove…</strong> beside an imported bundle archives what
              it created, and a newer file archives what it dropped. Anything
              still used from outside the bundle — a fragment one of your
              queries reads, a chart on one of your dashboards — is kept, and
              the list says why. Nothing is deleted: importing the bundle again
              brings it all back.
            </p>
          </Section>

          <Section id="lineage">
            <p>
              Press <kbd>⌘K</kbd> (<kbd>Ctrl K</kbd> on Windows and Linux), or{' '}
              <kbd>/</kbd> when not typing, to search every dashboard, query,
              chart, fragment and table, plus these sections.
            </p>
            <p>
              <Link href="/lineage">Lineage</Link> lays everything out in the
              direction data flows: tables, fragments, queries, charts,
              dashboards. Pick an item to light up what it is made from and what
              would change with it, before you edit a fragment or retire a
              table.
            </p>
          </Section>

          <Section id="shortcuts">
            <table className="guide-table">
              <tbody>
                <tr>
                  <td>
                    <kbd>⌘K</kbd> or <kbd>/</kbd>
                  </td>
                  <td>Search</td>
                </tr>
                <tr>
                  <td>
                    <kbd>⌘↵</kbd>
                  </td>
                  <td>Run the query in the editor, or the selected part</td>
                </tr>
                <tr>
                  <td>
                    <kbd>⌘S</kbd>
                  </td>
                  <td>Save the query</td>
                </tr>
                <tr>
                  <td>
                    <kbd>⇧⌥F</kbd>
                  </td>
                  <td>Format the SQL</td>
                </tr>
                <tr>
                  <td>
                    <kbd>⌘/</kbd>
                  </td>
                  <td>Comment or uncomment the selected lines</td>
                </tr>
                <tr>
                  <td>
                    <kbd>{'{{'}</kbd>
                  </td>
                  <td>Complete a placeholder, fragment or parameter</td>
                </tr>
                <tr>
                  <td>Arrow keys on a tile&apos;s grip</td>
                  <td>Move or resize a tile while editing a dashboard</td>
                </tr>
              </tbody>
            </table>
            <p className="studio-muted">
              On Windows and Linux, <kbd>Ctrl</kbd> stands in for <kbd>⌘</kbd>.
            </p>
          </Section>

          <Section id="faq">
            <Question question="Why does a chart still show old numbers?">
              <p>
                Charts read the stored result, not the data source. Look at the
                chart&apos;s footer: if it is amber, the query changed since the
                last run; open the query and choose <em>Run and store</em>, or
                give it a refresh schedule.
              </p>
            </Question>
            <Question question="I changed the SQL but the chart did not change.">
              <p>
                A chart reads the result of the <em>saved</em> version. Save,
                then <em>Run and store</em>.
              </p>
            </Question>
            <Question question="Why is Run and store greyed out?">
              <p>
                The draft has unsaved changes, and a stored result always comes
                from a saved version. Save first.
              </p>
            </Question>
            <Question question="My query was stopped after 30 seconds.">
              <p>
                That is the preview time limit. <em>Explain</em> shows where the
                work goes: a sequential scan of a large table usually means a
                missing filter or index. Make the query lighter, or raise the
                query&apos;s own limit under <em>Run limits</em> in its About
                panel.
              </p>
            </Question>
            <Question question="The result says it was cut.">
              <p>
                It returned more rows than the cap kept. Aggregate in SQL (a
                chart rarely needs every raw row), or raise the cap under{' '}
                <em>Run limits</em>.
              </p>
            </Question>
            <Question question="A chart is empty on the dashboard but not on its query.">
              <p>
                It probably filters on a dashboard variable: the range, or a
                selected value that is not set yet. Check the variables across
                the top, and the chart&apos;s filters.
              </p>
            </Question>
            <Question question="Can a query change data?">
              <p>
                No. Queries run in a read-only transaction, as a role that can
                only read, and statements that write are refused before they
                run.
              </p>
            </Question>
            <Question question="Who can see what?">
              <p>
                Public queries and dashboards are readable by anyone; unlisted
                ones by anyone with the link; private ones by editors only. A
                chart on a private query is shown on a public dashboard, but its
                query is not linked.
              </p>
            </Question>
            <Question question="How do I share a dashboard?">
              <p>
                <strong>Share</strong>, beside Edit, gives its link. While it is
                private only editors can open it: choose{' '}
                <em>Anyone with the link</em> to share it without listing it, or{' '}
                <em>Everyone</em> to list it. The link keeps the filters as they
                are on screen, unless you untick that. A query is shared the
                same way, from its page.
              </p>
            </Question>
            <Question question="What changes if I edit a fragment?">
              <p>
                Every query that uses it, directly or through another fragment,
                and the charts drawn from them. Its About panel lists them, and{' '}
                <Link href="/lineage">Lineage</Link> shows the whole chain.
              </p>
            </Question>
          </Section>
        </article>
      </div>
    </main>
  );
}
