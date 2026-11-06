'use client';

import { useEffect, useState } from 'react';

import { api, type Lineage } from './api';
import { useSession } from './session';

/**
 * The lineage graph, fetched once per editing state and shared by the search
 * palette and the lineage page. `refresh` asks again in the background; the
 * last answer stays on screen meanwhile.
 */

let cached: { key: string; at: number; data: Lineage } | null = null;
let pending: { key: string; promise: Promise<Lineage> } | null = null;

const FRESH_MS = 30_000;

function load(key: string, force: boolean): Promise<Lineage> {
  if (!force && cached?.key === key && Date.now() - cached.at < FRESH_MS) {
    return Promise.resolve(cached.data);
  }
  if (pending?.key === key) return pending.promise;
  const promise = api<Lineage>('/api/v1/lineage').then((data) => {
    cached = { key, at: Date.now(), data };
    return data;
  });
  pending = { key, promise };
  void promise.finally(() => {
    if (pending?.promise === promise) pending = null;
  });
  return promise;
}

export function useLineage(active = true): {
  lineage: Lineage | null;
  error: string | null;
} {
  const { user } = useSession();
  const key = user === undefined ? 'unknown' : user ? 'editor' : 'reader';
  const [state, setState] = useState<{
    key: string;
    lineage: Lineage | null;
    error: string | null;
  }>(() => ({
    key,
    lineage: cached?.key === key ? cached.data : null,
    error: null,
  }));
  useEffect(() => {
    if (!active || key === 'unknown') return;
    let live = true;
    load(key, false)
      .then((lineage) => live && setState({ key, lineage, error: null }))
      .catch(
        (error: unknown) =>
          live &&
          setState({
            key,
            lineage: null,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    return () => {
      live = false;
    };
  }, [active, key]);
  // A change of editing state shows nothing stale while the new graph loads.
  return state.key === key
    ? { lineage: state.lineage, error: state.error }
    : { lineage: cached?.key === key ? cached.data : null, error: null };
}
