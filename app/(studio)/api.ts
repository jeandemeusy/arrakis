/**
 * The studio's way to call the query-store API.
 *
 * Every failure becomes an ApiError carrying the server's message, so a
 * component can show exactly what the backend said — "Sign in to edit.",
 * a PostgreSQL syntax error with its hint — rather than a generic failure.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(
    status: number,
    message: string,
    details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers:
        options.body === undefined
          ? undefined
          : { 'content-type': 'application/json' },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError(0, 'The server could not be reached.', {});
  }
  let payload: Record<string, unknown> = {};
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    // An empty or non-JSON body still has a status worth reporting.
  }
  if (!response.ok) {
    const { error, ...details } = payload;
    throw new ApiError(
      response.status,
      typeof error === 'string' ? error : `Request failed (${response.status})`,
      details,
    );
  }
  return payload as T;
}

/** Shared shapes of the API's answers. */

export type ColumnType =
  | 'boolean'
  | 'bytes'
  | 'text'
  | 'integer'
  | 'bigint'
  | 'float'
  | 'numeric'
  | 'date'
  | 'timestamp'
  | 'timestamptz'
  | 'json';

export type Column = { name: string; type: ColumnType };

export type ParameterType =
  | 'text'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'date'
  | 'timestamp'
  | 'address'
  | 'text[]'
  | 'integer[]'
  | 'address[]'
  | 'enum';

export const PARAMETER_TYPES: ParameterType[] = [
  'text',
  'integer',
  'number',
  'boolean',
  'date',
  'timestamp',
  'address',
  'text[]',
  'integer[]',
  'address[]',
  'enum',
];

export type ParameterDefinition = {
  name: string;
  type: ParameterType;
  label?: string;
  default?: unknown;
  options?: string[];
};

export type QueryVersion = {
  id: string;
  version: number;
  sql: string;
  parameters: ParameterDefinition[];
  note: string;
  createdBy: string | null;
  createdAt: string;
};

export type Visibility = 'private' | 'unlisted' | 'public';
export type Kind = 'query' | 'fragment';
export type Combine = 'concat' | 'hidden';

export type QueryRecord = {
  id: string;
  slug: string;
  title: string;
  description: string;
  kind: Kind;
  visibility: Visibility;
  official: boolean;
  combine: Combine;
  refreshSeconds: number | null;
  /** How long a run may take; null takes the server's default. */
  timeoutSeconds: number | null;
  /** How many rows a stored result keeps; null takes the server's default. */
  rowLimit: number | null;
  forkedFrom: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  current: QueryVersion | null;
};

export type QuerySummary = Omit<QueryRecord, 'current'> & {
  version: number | null;
  /** Fragments: the arguments it takes, in order. */
  arguments?: string[];
  /** Fragments: stands in for a value rather than a table. */
  expression?: boolean;
};

export type Dependent = {
  slug: string;
  title: string;
  kind: 'query' | 'fragment';
  direct: boolean;
  charts: number;
};

export type Network = { id: string; label: string };

export type Preview = {
  columns: Column[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  networks: Array<{
    id: string;
    rowCount: number;
    durationMs: number;
    timebase: 'rpc' | 'estimated' | null;
    error?: string;
  }>;
};

export type ResultPage = {
  query: string;
  version: number;
  networks: Array<{
    id: string;
    status: 'ready' | 'pending' | 'failed';
    rowCount: number | null;
    truncated: boolean;
    finishedAt: string | null;
    durationMs: number | null;
    timebase: 'rpc' | 'estimated' | null;
    stale: boolean;
    lastAttempt: {
      status: string;
      at: string | null;
      error: string | null;
    } | null;
  }>;
  parameters: Record<string, unknown>;
  columns: Column[];
  rows: unknown[][];
  offset: number;
  limit: number;
};

export type SchemaTable = {
  schema: string;
  name: string;
  kind: 'table' | 'view';
  columns: Array<{ name: string; type: string }>;
};

export type Exit = {
  address: string;
  label: string;
  addedAt: string;
  addedBy: string | null;
};

export type ExitActivity = {
  address: string;
  lastBlock: string | null;
  lastAt: string | null;
  redemptions: string;
};

export type VariableType = 'range' | 'network' | 'text' | 'select';

export type DashboardVariable = {
  name: string;
  label: string;
  type: VariableType;
  default?: string;
  options?: string[];
  /** Display names for some options, e.g. 31d → "Last 30 days". */
  labels?: Record<string, string>;
};

export type WidgetOptions = {
  title?: string;
  link?: { column: string; var: string; dashboard?: string };
  requires?: string;
  note?: string;
};

export type SavedVisualization = {
  id: string;
  query: string;
  queryTitle: string;
  queryVisibility: Visibility;
  title: string;
  description: string;
  type: import('@/lib/viz/config').VisualizationType;
  config: import('@/lib/viz/config').VisualizationConfig;
  updatedAt: string;
};

export type DashboardWidget = {
  id: string;
  kind: 'visualization' | 'text';
  visualization: SavedVisualization | null;
  text: string;
  /** Columns of the 12-column grid, 1 to 12. */
  width: number;
  height: number;
  options: WidgetOptions;
};

export type DashboardRecord = {
  id: string;
  slug: string;
  title: string;
  description: string;
  visibility: Visibility;
  variables: DashboardVariable[];
  createdBy: string | null;
  updatedAt: string;
  archivedAt: string | null;
  widgets: DashboardWidget[];
};

export type LineageKind =
  | 'table'
  | 'fragment'
  | 'query'
  | 'chart'
  | 'dashboard';

export type LineageNode = {
  id: string;
  kind: LineageKind;
  label: string;
  detail: string;
  description: string;
  href: string;
};

export type Lineage = {
  nodes: LineageNode[];
  edges: Array<{ from: string; to: string }>;
};
