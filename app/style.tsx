'use client';

import { useCallback, useMemo, useSyncExternalStore } from 'react';

import {
  DEFAULT_STYLE,
  PALETTES,
  STYLES,
  STYLE_STORAGE_KEY,
  isStyle,
  type Palette,
  type StyleName,
} from './chart-theme';

/**
 * Which visual style the page is wearing.
 *
 * The page itself needs no React state to restyle: every rule in `globals.css`
 * reads its appearance from tokens under `[data-style]` on <html>, which the
 * pre-paint script in `layout.tsx` sets before the first frame. So the attribute
 * — not a hook — is where the style actually lives, and this module subscribes
 * to it for the one thing the cascade cannot reach: the SVG recharts draws,
 * whose colours are props rather than styles.
 *
 * `useSyncExternalStore` rather than state seeded in an effect, because the
 * server rendered the default and the attribute may already say otherwise by the
 * time React arrives. The server snapshot is the default, so hydration matches
 * the markup; React then re-reads the live snapshot and, if the visitor had
 * chosen the other style, redraws with it. No frame shows the wrong page — the
 * script already restyled it — and no effect writes state during render.
 */
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): StyleName {
  const applied = document.documentElement.dataset.style;
  return isStyle(applied) ? applied : DEFAULT_STYLE;
}

function getServerSnapshot(): StyleName {
  return DEFAULT_STYLE;
}

/** Writes the choice where the cascade and the next page load will both see it. */
function apply(style: StyleName) {
  document.documentElement.dataset.style = style;
  try {
    localStorage.setItem(STYLE_STORAGE_KEY, style);
  } catch {
    // A browser that refuses storage still gets the style, just not the memory.
  }
  for (const listener of listeners) listener();
}

export function useStyle() {
  const style = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setStyle = useCallback((next: StyleName) => apply(next), []);
  return useMemo(
    () => ({ style, palette: PALETTES[style], setStyle }),
    [style, setStyle],
  );
}

/** The colours and mark weights the charts draw with under the current style. */
export function usePalette(): Palette {
  return PALETTES[
    useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  ];
}

export function StyleSwitch() {
  const { style, setStyle } = useStyle();
  return (
    <fieldset className="style-switch">
      <legend className="sr-only">Visual style</legend>
      {STYLES.map((entry) => (
        <button
          key={entry.id}
          type="button"
          aria-pressed={style === entry.id}
          className={style === entry.id ? 'active' : ''}
          onClick={() => setStyle(entry.id)}
        >
          {entry.label}
        </button>
      ))}
    </fieldset>
  );
}
