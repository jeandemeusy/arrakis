'use client';

import { useEffect, useMemo, useState } from 'react';
import { variablesOf } from '@/lib/viz/config';
import { type WidgetPayload } from '../../viz/widget-tile';
import {
  api,
  ApiError,
  type DashboardWidget,
  type SavedVisualization,
} from '../api';

export type DataResponse = {
  vars: Record<string, string | undefined>;
  widgets: Array<
    | {
        id: string;
        state: 'ok';
        data: Extract<WidgetPayload, { state: 'ok' }>['data'];
      }
    | { id: string; state: 'hidden' | 'text' }
    /** Its query is private or archived: the tile stays, the data does not come. */
    | { id: string; state: 'private' }
    | { id: string; state: 'error'; error: { status: number; message: string } }
  >;
};

export type RunState = {
  query: string;
  running: boolean;
  finishedAt: string | null;
  failed: boolean;
};

export const LOADING: WidgetPayload = { state: 'loading' };

/**
 * One payload object per data entry, so an unchanged chart is handed the very
 * same props and is not redrawn. Entries are never reused across dashboards,
 * so a module-wide map is safe, and it lets go of them with the data.
 */
export const payloads = new WeakMap<object, WidgetPayload>();

/**
 * The new response, with every widget whose data did not change kept as the
 * very object already on screen — so its tile is not redrawn.
 */
export function keepUnchanged(
  previous: DataResponse | null,
  next: DataResponse,
): DataResponse {
  if (!previous) return next;
  const before = new Map(previous.widgets.map((entry) => [entry.id, entry]));
  return {
    ...next,
    widgets: next.widgets.map((entry) => {
      const old = before.get(entry.id);
      return old && JSON.stringify(old) === JSON.stringify(entry) ? old : entry;
    }),
  };
}

/** The variables a chart reads, worked out once per chart. */
const reads = new WeakMap<object, Set<string>>();

export function readsOf(visualization: SavedVisualization): Set<string> {
  let names = reads.get(visualization);
  if (!names) {
    names = variablesOf(visualization.config);
    reads.set(visualization, names);
  }
  return names;
}

/** A widget being edited: saved ones keep their id, new ones get a local one. */
export type DraftWidget = DashboardWidget & { local?: boolean };

/** One widget's data, fetched on its own: for widgets added while editing. */
export function useWidgetData(
  id: string | null,
  network: string,
  vars: Record<string, string | undefined>,
  skip: boolean,
  sources?: string,
): WidgetPayload {
  const [payload, setPayload] = useState<WidgetPayload>({ state: 'loading' });
  const search = useMemo(() => {
    const params = new URLSearchParams({ network });
    if (sources)
      for (const source of sources.split(',')) params.append('source', source);
    for (const [key, value] of Object.entries(vars))
      if (value) params.set(`v.${key}`, value);
    return params.toString();
  }, [network, vars, sources]);
  useEffect(() => {
    if (skip || !id) return;
    let live = true;
    api<Extract<WidgetPayload, { state: 'ok' }>['data']>(
      `/api/v1/visualizations/${id}/data?${search}`,
    )
      .then((data) => live && setPayload({ state: 'ok', data }))
      .catch(
        (error: ApiError) =>
          live &&
          setPayload({
            state: 'error',
            error: { status: error.status, message: error.message },
          }),
      );
    return () => {
      live = false;
    };
  }, [id, search, skip]);
  return payload;
}
