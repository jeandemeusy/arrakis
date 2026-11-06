'use client';

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';

import {
  DEFAULT_STYLE,
  DEFAULT_THEME,
  STYLES,
  STYLE_STORAGE_KEY,
  THEMES,
  THEME_STORAGE_KEY,
  isStyle,
  isThemeChoice,
  paletteOf,
  type Palette,
  type StyleName,
  type Theme,
  type ThemeChoice,
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

/**
 * Light or dark: `data-theme` on <html>, resolved from the visitor's choice
 * (light, dark, or the system's) by the same pre-paint script, and kept in
 * step here when the choice or the system's setting changes.
 */
function getTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function getThemeChoice(): ThemeChoice {
  const chosen = document.documentElement.dataset.themeChoice;
  return isThemeChoice(chosen) ? chosen : DEFAULT_THEME;
}

const systemDark = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches;

function applyTheme(choice: ThemeChoice, remember: boolean) {
  const root = document.documentElement;
  root.dataset.themeChoice = choice;
  root.dataset.theme =
    choice === 'dark' || (choice === 'system' && systemDark())
      ? 'dark'
      : 'light';
  if (remember) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, choice);
    } catch {
      // Applied for this visit only.
    }
  }
  for (const listener of listeners) listener();
}

export function useStyle() {
  const style = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const theme = useSyncExternalStore<Theme>(subscribe, getTheme, () => 'light');
  const setStyle = useCallback((next: StyleName) => apply(next), []);
  return useMemo(
    () => ({ style, palette: paletteOf(style, theme), setStyle }),
    [style, theme, setStyle],
  );
}

/** The colours and mark weights the charts draw with under the current style. */
export function usePalette(): Palette {
  const style = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const theme = useSyncExternalStore<Theme>(subscribe, getTheme, () => 'light');
  return paletteOf(style, theme);
}

/** Light, dark, or as the system says; only the editorial style has a dark. */
export function ThemeSwitch() {
  const style = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const choice = useSyncExternalStore(
    subscribe,
    getThemeChoice,
    () => DEFAULT_THEME,
  );
  // Following the system: a change there applies at once.
  useEffect(() => {
    if (choice !== 'system') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system', false);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [choice]);
  if (style !== 'editorial') return null;
  const icons = { light: Sun, dark: Moon, system: Monitor };
  return (
    <fieldset className="theme-switch">
      <legend className="sr-only">Light or dark</legend>
      {THEMES.map((entry) => {
        const Icon = icons[entry.id];
        return (
          <button
            key={entry.id}
            type="button"
            aria-pressed={choice === entry.id}
            title={entry.id === 'system' ? 'As the system is set' : entry.label}
            aria-label={entry.label}
            onClick={() => applyTheme(entry.id, true)}
          >
            <Icon size={14} aria-hidden="true" />
          </button>
        );
      })}
    </fieldset>
  );
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
