/**
 * The set of Blokli index databases the dashboard reads.
 *
 * Configured with `NETWORKS`, a JSON array:
 *
 *   NETWORKS='[{"id":"jura","label":"Jura","databaseUrl":"postgres://…","rpcUrl":"https://…"}]'
 *
 * A lone `DATABASE_URL` still works and is read as a single unnamed network, so an
 * existing single-network deployment needs no configuration change.
 *
 * Exit addresses are configuration rather than something read off the chain.
 * Nothing on chain distinguishes an exit from a relay — both announce — and an
 * exit that also relays for clients cannot be told apart by elimination at all.
 * Naming them is the only reliable way, until the service registry does it:
 *
 *   EXITS='0xabc…,0xdef…'                       applies to every network
 *   NETWORKS='[{…,"exits":["0xabc…"]}]'         overrides it for one network
 */

export type NetworkConfig = {
  id: string;
  label: string;
  databaseUrl: string;
  rpcUrl: string | null;
  /** Known exit addresses, lowercased. Empty means none were configured. */
  exits: string[];
};

/** What the browser is told about a network: never the connection string. */
export type NetworkSummary = {
  id: string;
  label: string;
};

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

/**
 * Parses a list of addresses, from a JSON array or a delimited string.
 *
 * Addresses are lowercased because a checksummed address and the same address in
 * lower case are the same account, and the chain hands them over in lower case.
 * A malformed entry throws: an exit silently dropped for a typo would take its
 * traffic out of the downstream figure with nothing to show for it.
 */
function parseAddresses(input: unknown, where: string): string[] {
  if (input === undefined || input === null) return [];
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[\s,]+/)
      : null;
  if (!raw) throw new Error(`${where} must be an array or a delimited string`);

  const addresses = raw
    .map((entry) =>
      typeof entry === 'string' ? entry.trim().toLowerCase() : '',
    )
    .filter((entry) => entry.length > 0);
  for (const address of addresses) {
    if (!ADDRESS_PATTERN.test(address)) {
      throw new Error(
        `${where} contains ${JSON.stringify(address)}, which is not an address`,
      );
    }
  }
  return [...new Set(addresses)];
}

function isPostgres(url: string): boolean {
  return url.startsWith('postgres://') || url.startsWith('postgresql://');
}

function parseEntry(entry: unknown, index: number): NetworkConfig {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`NETWORKS[${index}] is not an object`);
  }
  const record = entry as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const databaseUrl =
    typeof record.databaseUrl === 'string' ? record.databaseUrl.trim() : '';
  const label =
    typeof record.label === 'string' && record.label.trim()
      ? record.label.trim()
      : id;
  const rpcUrl =
    typeof record.rpcUrl === 'string' && record.rpcUrl.trim()
      ? record.rpcUrl.trim()
      : null;
  const exits =
    record.exits === undefined
      ? defaultExits()
      : parseAddresses(record.exits, `NETWORKS[${index}].exits`);

  if (!ID_PATTERN.test(id)) {
    throw new Error(
      `NETWORKS[${index}].id must be lowercase letters, digits or dashes; got ${JSON.stringify(record.id)}`,
    );
  }
  if (!isPostgres(databaseUrl)) {
    throw new Error(
      `NETWORKS[${index}].databaseUrl must be a PostgreSQL connection string`,
    );
  }
  return { id, label, databaseUrl, rpcUrl, exits };
}

/** Exits shared by every network, unless one names its own. */
function defaultExits(): string[] {
  return parseAddresses(process.env.EXITS?.trim() || null, 'EXITS');
}

/**
 * Reads the configured networks, newest configuration format first.
 *
 * Throws rather than silently falling back: a malformed `NETWORKS` almost always
 * means a deployment mistake, and quietly serving one network — or none — would
 * hide it behind an empty dashboard.
 */
export function resolveNetworks(): NetworkConfig[] {
  const raw = process.env.NETWORKS?.trim();

  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('NETWORKS is not valid JSON');
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('NETWORKS must be a non-empty JSON array');
    }
    const networks = parsed.map(parseEntry);
    const ids = new Set(networks.map((network) => network.id));
    if (ids.size !== networks.length) {
      throw new Error('NETWORKS contains duplicate ids');
    }
    return networks;
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is not configured');
  if (!isPostgres(databaseUrl)) {
    throw new Error(
      'The dashboard backend currently requires a PostgreSQL DATABASE_URL',
    );
  }
  return [
    {
      id: 'default',
      label: 'Network',
      databaseUrl,
      rpcUrl: process.env.RPC_URL?.trim() || null,
      exits: defaultExits(),
    },
  ];
}
