/**
 * Compares the saved-query dashboard with the page it replaces, on live data.
 *
 *   npm run parity                    every network, then all of them together
 *   npm run parity -- --network jura  one view
 *   npm run parity -- --no-refresh    use the stored results as they are
 *
 * Reads the same environment as the app (NETWORKS or DATABASE_URL, and
 * APP_DATABASE_URL). Installs the bundled Gnosis VPN dashboard if it is not
 * there yet — or updates it, with --install — then runs its queries on each
 * network so both sides read the index at the same moment, and prints one
 * line per figure. Exits 1 when anything differs.
 *
 * Exits must be configured on the Exits page (/settings/networks): both sides use that list.
 */
import { checkParity, type ParityLine } from '../lib/parity';
import { HttpError } from '../lib/api/errors';
import { resolveNetworks, type NetworkConfig } from '../lib/networks';
import { holdClocks } from '../lib/query/clock';
import { listExits } from '../lib/query/exits';
import { materialize } from '../lib/query/results';
import { getQuery } from '../lib/query/store';
import {
  installSeed,
  installed,
  installerPrincipal,
  seedOf,
} from '../lib/seed/install';
import { closeAppDb } from '../lib/db/app';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};

const MARK: Record<ParityLine['status'], string> = {
  match: '  ok ',
  close: '  ~  ',
  expected: ' note',
  differs: ' DIFF',
};

async function refresh(network: NetworkConfig): Promise<void> {
  for (const definition of seedOf('gnosis-vpn').queries) {
    if (definition.kind !== 'query') continue;
    const query = await getQuery(definition.slug);
    if (!query) throw new Error(`${definition.slug} is not installed`);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const started = Date.now();
        const stored = await materialize({
          query,
          network,
          supplied: {},
          trigger: 'editor',
        });
        console.log(
          `  ${network.id} · ${definition.slug}: ${stored.rowCount} rows in ${Date.now() - started} ms`,
        );
        break;
      } catch (error) {
        // The app's scheduler is running this one right now; let it finish.
        if (
          error instanceof HttpError &&
          error.status === 409 &&
          attempt < 90
        ) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          continue;
        }
        throw error;
      }
    }
  }
}

function print(title: string, lines: ParityLine[]): number {
  console.log(`\n${title}`);
  let area = '';
  const width = Math.max(...lines.map((line) => line.metric.length));
  for (const line of lines) {
    if (line.area !== area) {
      area = line.area;
      console.log(`\n  ${area}`);
    }
    console.log(
      `${MARK[line.status]}  ${line.metric.padEnd(width)}  ${line.old.padStart(14)}  ${line.new.padStart(14)}${line.note ? `  ${line.note}` : ''}`,
    );
  }
  const counts = lines.reduce<Record<string, number>>((tally, line) => {
    tally[line.status] = (tally[line.status] ?? 0) + 1;
    return tally;
  }, {});
  console.log(
    `\n  ${counts.match ?? 0} match, ${counts.close ?? 0} close, ${counts.expected ?? 0} expected differences, ${counts.differs ?? 0} differ`,
  );
  return counts.differs ?? 0;
}

async function main(): Promise<number> {
  const networks = resolveNetworks();
  // One clock per network for the whole run: the results it refreshes and
  // the snapshot it compares them with then date every block identically.
  holdClocks();
  if (flag('install') || !(await installed('gnosis-vpn'))) {
    const report = await installSeed('gnosis-vpn', await installerPrincipal());
    console.log(
      `Installed the Gnosis VPN dashboard: ${report.created.length} created, ${report.updated.length} updated, ${report.unchanged.length} unchanged.`,
    );
  }
  const wanted = option('network');
  const targets = wanted
    ? wanted === 'all'
      ? networks
      : networks.filter((network) => network.id === wanted)
    : networks;
  if (!targets.length) throw new Error(`No network "${wanted}"`);

  for (const network of targets) {
    if (!(await listExits(network.id)).length) {
      console.log(
        `\n${network.label}: no exits configured. Downstream will not compare; add them on the Exits page, /settings/networks.`,
      );
    }
  }
  if (!flag('no-refresh')) {
    console.log('\nRunning the dashboard queries…');
    for (const network of targets) await refresh(network);
  }

  let differing = 0;
  const views: NetworkConfig[][] =
    wanted === 'all'
      ? [targets]
      : wanted
        ? [targets]
        : [
            ...targets.map((network) => [network]),
            ...(targets.length > 1 ? [targets] : []),
          ];
  for (const view of views) {
    const title =
      view.length === 1 ? `${view[0].label} (${view[0].id})` : 'All networks';
    differing += print(title, await checkParity(view));
  }
  return differing ? 1 : 0;
}

main()
  .then(async (code) => {
    await closeAppDb().catch(() => undefined);
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await closeAppDb().catch(() => undefined);
    process.exit(2);
  });
