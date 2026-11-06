/**
 * The data sources Arrakis queries: PostgreSQL databases (or anything that
 * speaks its protocol — Supabase, Neon, RDS, Timescale…), each reached through
 * a role that can only read.
 *
 * Configured in the deployment, not in the app, with `DATA_SOURCES`, a JSON
 * array:
 *
 *   DATA_SOURCES='[{"id":"prod","label":"Production","databaseUrl":"postgres://…"}]'
 *
 * `queryDatabaseUrl`, optional, is where saved queries actually run: a read
 * replica, or the same database under a stricter role. A lone `DATABASE_URL`
 * still works and is read as one source, and `NETWORKS` — this variable's
 * name before Arrakis read more than one kind of database — is read as
 * `DATA_SOURCES`.
 *
 * Internally a data source is still a "network" in names and columns: that is
 * what the first one was.
 */

export type NetworkConfig = {
  id: string;
  label: string;
  databaseUrl: string;
  /** Where saved queries run. Defaults to `databaseUrl`. */
  queryDatabaseUrl: string;
};

/** What the browser is told about a data source: never the connection string. */
export type NetworkSummary = {
  id: string;
  label: string;
};

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

function isPostgres(url: string): boolean {
  return url.startsWith('postgres://') || url.startsWith('postgresql://');
}

function parseEntry(
  entry: unknown,
  index: number,
  variable: string,
): NetworkConfig {
  const where = `${variable}[${index}]`;
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`${where} is not an object`);
  }
  const record = entry as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const databaseUrl =
    typeof record.databaseUrl === 'string' ? record.databaseUrl.trim() : '';
  const label =
    typeof record.label === 'string' && record.label.trim()
      ? record.label.trim()
      : id;
  const queryDatabaseUrl =
    typeof record.queryDatabaseUrl === 'string' &&
    record.queryDatabaseUrl.trim()
      ? record.queryDatabaseUrl.trim()
      : databaseUrl;

  if (!ID_PATTERN.test(id)) {
    throw new Error(
      `${where}.id must be lowercase letters, digits or dashes; got ${JSON.stringify(record.id)}`,
    );
  }
  if (!isPostgres(databaseUrl)) {
    throw new Error(
      `${where}.databaseUrl must be a PostgreSQL connection string`,
    );
  }
  if (!isPostgres(queryDatabaseUrl)) {
    throw new Error(
      `${where}.queryDatabaseUrl must be a PostgreSQL connection string`,
    );
  }
  return { id, label, databaseUrl, queryDatabaseUrl };
}

/**
 * Reads the configured data sources.
 *
 * Throws rather than silently falling back: a malformed `DATA_SOURCES` almost
 * always means a deployment mistake, and quietly serving one source — or none
 * — would hide it behind empty dashboards.
 */
export function resolveNetworks(): NetworkConfig[] {
  const variable = process.env.DATA_SOURCES?.trim()
    ? 'DATA_SOURCES'
    : process.env.NETWORKS?.trim()
      ? 'NETWORKS'
      : null;
  const raw = variable ? process.env[variable]!.trim() : null;

  if (variable && raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${variable} is not valid JSON`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error(`${variable} must be a non-empty JSON array`);
    }
    const sources = parsed.map((entry, index) =>
      parseEntry(entry, index, variable),
    );
    const ids = new Set(sources.map((source) => source.id));
    if (ids.size !== sources.length) {
      throw new Error(`${variable} contains duplicate ids`);
    }
    return sources;
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('No data source: set DATA_SOURCES, or DATABASE_URL');
  }
  if (!isPostgres(databaseUrl)) {
    throw new Error('DATABASE_URL must be a PostgreSQL connection string');
  }
  return [
    {
      id: 'default',
      label: 'Default',
      databaseUrl,
      queryDatabaseUrl: process.env.QUERY_DATABASE_URL?.trim() || databaseUrl,
    },
  ];
}
