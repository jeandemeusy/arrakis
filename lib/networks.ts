/**
 * The set of Blokli index databases the dashboard reads.
 *
 * Configured with `NETWORKS`, a JSON array:
 *
 *   NETWORKS='[{"id":"jura","label":"Jura","databaseUrl":"postgres://…","rpcUrl":"https://…"}]'
 *
 * A lone `DATABASE_URL` still works and is read as a single unnamed network, so an
 * existing single-network deployment needs no configuration change.
 */

export type NetworkConfig = {
  id: string;
  label: string;
  databaseUrl: string;
  rpcUrl: string | null;
};

/** What the browser is told about a network: never the connection string. */
export type NetworkSummary = {
  id: string;
  label: string;
};

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

function isPostgres(url: string): boolean {
  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

function parseEntry(entry: unknown, index: number): NetworkConfig {
  if (typeof entry !== "object" || entry === null) {
    throw new Error(`NETWORKS[${index}] is not an object`);
  }
  const record = entry as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const databaseUrl = typeof record.databaseUrl === "string" ? record.databaseUrl.trim() : "";
  const label = typeof record.label === "string" && record.label.trim() ? record.label.trim() : id;
  const rpcUrl = typeof record.rpcUrl === "string" && record.rpcUrl.trim() ? record.rpcUrl.trim() : null;

  if (!ID_PATTERN.test(id)) {
    throw new Error(
      `NETWORKS[${index}].id must be lowercase letters, digits or dashes; got ${JSON.stringify(record.id)}`,
    );
  }
  if (!isPostgres(databaseUrl)) {
    throw new Error(`NETWORKS[${index}].databaseUrl must be a PostgreSQL connection string`);
  }
  return { id, label, databaseUrl, rpcUrl };
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
      throw new Error("NETWORKS is not valid JSON");
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("NETWORKS must be a non-empty JSON array");
    }
    const networks = parsed.map(parseEntry);
    const ids = new Set(networks.map((network) => network.id));
    if (ids.size !== networks.length) {
      throw new Error("NETWORKS contains duplicate ids");
    }
    return networks;
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is not configured");
  if (!isPostgres(databaseUrl)) {
    throw new Error("The dashboard backend currently requires a PostgreSQL DATABASE_URL");
  }
  return [
    {
      id: "default",
      label: "Network",
      databaseUrl,
      rpcUrl: process.env.RPC_URL?.trim() || null,
    },
  ];
}
