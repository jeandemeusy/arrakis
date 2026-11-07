'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { List } from 'lucide-react';

import type { Options } from '@/lib/viz/config';
import { usePalette } from '../../../style';
import { VisualizationBody } from '../../../viz/visualization';
import { api, ApiError } from '../../api';
import { took } from '../../time';

export const WINDOWS = ['24h', '7d', '30d'] as const;
export type Window = (typeof WINDOWS)[number];

const WINDOW_LABEL: Record<Window, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};

type RunTime = {
  slug: string;
  title: string;
  runs: number;
  failures: number;
  medianMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  lastMs: number | null;
  limitMs: number;
};

export type Run = {
  id: string;
  slug: string;
  title: string;
  network: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'succeeded' | 'failed';
  trigger: string | null;
  error: string | null;
  durationMs: number | null;
  rowCount: string | null;
  limitMs: number;
};

/** Runs drawn for one query: the newest this many, in its window. */
const RUNS_DRAWN = 500;
const LIMIT_SERIES = 'Time limit';
const FAILED_COLOR = '#c2410c';

const seconds = (ms: number | null) => (ms === null ? null : ms / 1000);

/**
 * How long stored runs take: every query's median and 95th percentile over a
 * window, slowest first, and one query's runs over time against its time
 * limit — so a slow query, or one getting slower, shows without reading rows.
 * The runs themselves are a click away, under All runs.
 */
export function RunTimes() {
  const [window, setWindow] = useState<Window>('7d');
  const [queries, setQueries] = useState<RunTime[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    api<{ queries: RunTime[] }>(`/api/v1/runs/times?window=${window}`)
      .then((result) => {
        if (!live) return;
        setError('');
        setQueries(result.queries);
      })
      .catch((failure: ApiError) => live && setError(failure.message));
    return () => {
      live = false;
    };
  }, [window]);

  // The slowest query until another is picked, and again when the picked
  // one ran nothing in the new window.
  const focus =
    queries?.find((query) => query.slug === selected) ?? queries?.[0] ?? null;

  const timed = useMemo(
    () => (queries ?? []).filter((query) => query.p95Ms !== null),
    [queries],
  );

  return (
    <section className="run-times">
      <div className="run-times-head">
        <h2>Run time</h2>
        <fieldset className="segmented">
          <legend className="sr-only">Window</legend>
          {WINDOWS.map((entry) => (
            <button
              key={entry}
              type="button"
              aria-pressed={entry === window}
              title={WINDOW_LABEL[entry]}
              onClick={() => {
                if (entry === window) return;
                setQueries(null);
                setWindow(entry);
              }}
            >
              {entry}
            </button>
          ))}
        </fieldset>
        <Link className="studio-button" href="/settings/runs/history">
          <List size={14} aria-hidden="true" /> All runs
        </Link>
      </div>
      <p className="studio-muted">
        How long stored and scheduled runs took, per query: median and 95th
        percentile over the window, slowest first, failed runs included. Pick a
        query to see its runs over time. Previews are not recorded.
      </p>
      {error && <p className="studio-error">{error}</p>}
      {!queries && !error && <p className="studio-muted">Loading run times…</p>}
      {queries &&
        (timed.length === 0 ? (
          <p className="studio-muted">
            No runs recorded in the {WINDOW_LABEL[window].toLowerCase()}.
          </p>
        ) : (
          <>
            <div className="studio-card run-times-card">
              <RunTimeBars
                queries={timed}
                selected={focus?.slug ?? null}
                onPick={setSelected}
              />
            </div>
            {focus && (
              <QueryRuns
                key={`${focus.slug}:${window}`}
                query={focus}
                queries={queries}
                window={window}
                onPick={setSelected}
              />
            )}
          </>
        ))}
    </section>
  );
}

/**
 * Every query as a labelled row, slowest first: its median and 95th
 * percentile as two bars on one scale. A list rather than a chart with the
 * queries along an axis, where names stop fitting long before queries run out.
 */
function RunTimeBars({
  queries,
  selected,
  onPick,
}: {
  queries: RunTime[];
  selected: string | null;
  onPick: (slug: string) => void;
}) {
  const palette = usePalette();
  const longest = Math.max(1, ...queries.map((query) => query.p95Ms ?? 0));
  const width = (ms: number | null) =>
    `${Math.max(0.5, ((ms ?? 0) / longest) * 100)}%`;
  const bar = (color: string) => ({
    background: color,
    border: palette.barStroke
      ? `${palette.barStrokeWidth}px solid ${palette.barStroke}`
      : undefined,
  });
  return (
    <>
      <p className="run-bars-legend">
        <span>
          <i style={bar(palette.accent)} /> Median
        </span>
        <span>
          <i style={bar(palette.accent2)} /> 95th percentile
        </span>
      </p>
      <ol className="run-bars">
        {queries.map((query) => (
          <li key={query.slug}>
            <button
              type="button"
              className="run-bar"
              aria-pressed={query.slug === selected}
              onClick={() => onPick(query.slug)}
            >
              <span className="run-bar-name" title={query.slug}>
                {query.title}
              </span>
              <span className="run-bar-track" aria-hidden="true">
                <i style={{ width: width(query.medianMs), ...bar(palette.accent) }} />
                <i style={{ width: width(query.p95Ms), ...bar(palette.accent2) }} />
              </span>
              <span className="run-bar-value">
                {took(query.medianMs)} · {took(query.p95Ms)}
                {query.failures > 0 && (
                  <small className="run-bar-failed">
                    {' '}
                    · {query.failures} failed
                  </small>
                )}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </>
  );
}

/**
 * One query's runs over the window against its time limit: a line per data
 * source, failed runs as bars, the limit as a line above.
 */
function QueryRuns({
  query,
  queries,
  window,
  onPick,
}: {
  query: RunTime;
  queries: RunTime[];
  window: Window;
  onPick: (slug: string) => void;
}) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    const params = new URLSearchParams({
      query: query.slug,
      window,
      limit: String(RUNS_DRAWN),
    });
    api<{ runs: Run[]; next: string | null }>(`/api/v1/runs/history?${params}`)
      .then((result) => {
        if (!live) return;
        setRuns(result.runs.filter((run) => run.durationMs !== null));
        setMore(result.next !== null);
      })
      .catch((failure: ApiError) => live && setError(failure.message));
    return () => {
      live = false;
    };
  }, [query.slug, window]);

  const sources = useMemo(
    () => [...new Set((runs ?? []).map((run) => run.network))].sort(),
    [runs],
  );
  const several = sources.length > 1;
  // Long form: one row per run, under its source (and whether it failed),
  // and one per run for the limit, drawn as a line over the bars.
  const rows = useMemo(() => {
    const label = (run: Run) =>
      run.status === 'failed'
        ? several
          ? `${run.network} · failed`
          : 'Failed'
        : several
          ? run.network
          : 'Run';
    return [...(runs ?? [])]
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .flatMap((run) => [
        [run.startedAt, label(run), seconds(run.durationMs)],
        [run.startedAt, LIMIT_SERIES, seconds(run.limitMs)],
      ]);
  }, [runs, several]);
  const options = useMemo<Options>(() => {
    const failed = several
      ? sources.map((source) => `${source} · failed`)
      : ['Failed'];
    return {
      format: 'decimal',
      legend: true,
      seriesOrder: 'rows',
      yAxis: { title: 'Seconds' },
      series: {
        [LIMIT_SERIES]: { mark: 'line' },
        ...Object.fromEntries(
          failed.map((key) => [key, { color: FAILED_COLOR, mark: 'bar' }]),
        ),
      },
    };
  }, [several, sources]);

  return (
    <div className="studio-card run-times-card">
      <div className="run-times-query">
        <label>
          <span className="sr-only">Query</span>
          <select
            className="studio-input"
            value={query.slug}
            onChange={(event) => onPick(event.target.value)}
          >
            {queries.map((entry) => (
              <option key={entry.slug} value={entry.slug}>
                {entry.title}
              </option>
            ))}
          </select>
        </label>
        <Link href={`/queries/${query.slug}`}>Open query</Link>
      </div>
      <p className="run-times-figures studio-muted">
        {query.runs} run{query.runs === 1 ? '' : 's'}
        {query.failures > 0 &&
          `, ${query.failures} failed`}{' '}
        · median {took(query.medianMs)} · 95th percentile {took(query.p95Ms)}
        {' '}· slowest {took(query.maxMs)} · limit {took(query.limitMs)}
        {more && ` · the newest ${RUNS_DRAWN} drawn`}
      </p>
      {error && <p className="studio-error">{error}</p>}
      {!runs && !error && <p className="studio-muted">Loading runs…</p>}
      {runs && (
        <VisualizationBody
          type="line"
          encoding={{ x: 'started', y: ['seconds'], series: 'series' }}
          options={options}
          columns={[
            { name: 'started', type: 'timestamptz' },
            { name: 'series', type: 'text' },
            { name: 'seconds', type: 'float' },
          ]}
          rows={rows}
          height={260}
        />
      )}
    </div>
  );
}
