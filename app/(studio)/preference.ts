'use client';

import { useSyncExternalStore } from 'react';

/**
 * A per-browser on/off preference (a panel shown or folded), kept in local
 * storage and read through an external store, so the server render and
 * hydration agree: the server renders the default, the browser its choice.
 */

const listeners = new Set<() => void>();
const memory = new Map<string, boolean>();

function read(key: string, fallback: boolean): boolean {
  if (memory.has(key)) return memory.get(key)!;
  let value = fallback;
  try {
    const stored = localStorage.getItem(key);
    if (stored === '1') value = true;
    else if (stored === '0') value = false;
  } catch {
    // Storage refused: the default stands.
  }
  memory.set(key, value);
  return value;
}

export function setPreference(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Storage refused: it still applies, just not for the next visit.
  }
  memory.set(key, value);
  for (const listener of listeners) listener();
}

export function usePreference(key: string, fallback: boolean): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => read(key, fallback),
    () => fallback,
  );
}
