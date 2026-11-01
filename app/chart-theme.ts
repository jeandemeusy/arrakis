/**
 * Palettes, formatters and scales shared by the page and its charts.
 *
 * Its own module so `app/charts.tsx` can be loaded on demand: importing these
 * from `dashboard.tsx` instead would make the chart bundle depend on the page
 * bundle, and pull recharts straight back into the initial download it is being
 * split out of. Nothing here may import recharts.
 *
 * Everything a plot draws with lives in a `Palette`, one per visual style, so a
 * chart never names a colour or a rule weight of its own. The values mirror the
 * CSS tokens in `app/globals.css` — SVG drawn by recharts takes no cascade from
 * the page, so the two have to be stated twice and kept in step.
 */

export const STYLES = [
  { id: 'editorial', label: 'Editorial' },
  { id: 'neubrutal', label: 'Neubrutal' },
] as const;

export type StyleName = (typeof STYLES)[number]['id'];

export const DEFAULT_STYLE: StyleName = 'neubrutal';

/** The key the choice is stored under, read by the pre-paint script in `layout.tsx`. */
export const STYLE_STORAGE_KEY = 'arrakis:style';

/**
 * Light or dark, for the editorial style; the neubrutal style is always light.
 * `system` follows the operating system's setting, and is the default.
 */
export const THEMES = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
] as const;

export type ThemeChoice = (typeof THEMES)[number]['id'];
export type Theme = 'light' | 'dark';

export const DEFAULT_THEME: ThemeChoice = 'system';
export const THEME_STORAGE_KEY = 'arrakis:theme';

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return THEMES.some((entry) => entry.id === value);
}

export function isStyle(value: unknown): value is StyleName {
  return STYLES.some((entry) => entry.id === value);
}

type Rgb = readonly [number, number, number];

export type Palette = {
  /** Tick labels on both axes. */
  axis: { fill: string; fontSize: number; fontWeight?: number };
  /** The horizontal rules behind a plot, and their dash pattern. */
  grid: string;
  gridDash: string | undefined;
  /** The band drawn under the hovered category. */
  cursor: { fill: string };
  tooltip: Record<string, string | number>;
  /** Same box, monospaced, for the tooltips that quote addresses. */
  addressTooltip: Record<string, string | number>;

  ink: string;
  surface: string;
  /** Legend and label text on an exported image. */
  muted: string;
  accent: string;
  accent2: string;
  accent3: string;
  /**
   * The two series that carry no accent of their own: a quiet comparison line,
   * and the cumulative total. In the editorial style both are near-neutral. In a
   * style that outlines every bar in black, the cumulative line cannot also be
   * black — it disappears into the outlines — so there it takes a colour.
   */
  seriesNeutral: string;
  seriesTotal: string;

  /** Marks: how a bar and a line are drawn, beyond their fill. */
  barStroke: string | undefined;
  barStrokeWidth: number;
  barRadius: [number, number, number, number];
  lineWidth: number;
  areaOpacity: number;
  /** Whether a series is drawn with a soft vertical gradient or a flat fill. */
  areaGradient: boolean;

  /**
   * The faces the PNG export draws with. An exported SVG carries no cascade from
   * the page, so it cannot read `--font-sans` and `--font-display`; these mirror
   * those two tokens so a saved picture looks like the page it came from.
   */
  faces: { sans: string; display: string };

  /** The heatmap and cohort ramp, blended from empty to full. */
  heatFrom: Rgb;
  heatTo: Rgb;
  /** The ramp many series are coloured from, blended across however many there are. */
  rampColors: readonly Rgb[];
  /**
   * Distinct colours for charts that colour series by name (stable colours),
   * and the swatches offered when picking a series' colour.
   */
  categorical: readonly string[];
};

const EDITORIAL: Palette = {
  axis: { fill: '#8b8d93', fontSize: 11 },
  grid: '#ececea',
  gridDash: undefined,
  cursor: { fill: 'rgb(27 28 31 / 0.05)' },
  tooltip: {
    background: '#ffffff',
    border: '1px solid #e2e2de',
    borderRadius: 8,
    boxShadow: '0 8px 24px rgb(0 0 0 / 0.10)',
    fontSize: 12,
    color: '#1b1c1f',
  },
  addressTooltip: {
    background: '#ffffff',
    border: '1px solid #e2e2de',
    borderRadius: 8,
    boxShadow: '0 8px 24px rgb(0 0 0 / 0.10)',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 11,
  },

  ink: '#1b1c1f',
  surface: '#ffffff',
  muted: '#6c6e74',
  accent: '#4f509b',
  accent2: '#e2643f',
  accent3: '#6bbaa2',
  seriesNeutral: '#9b9da2',
  seriesTotal: '#1b1c1f',

  barStroke: undefined,
  barStrokeWidth: 0,
  barRadius: [2, 2, 0, 0],
  lineWidth: 2,
  areaOpacity: 0.3,
  areaGradient: true,

  faces: {
    sans: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
    display: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
  },

  heatFrom: [244, 244, 242],
  heatTo: [79, 80, 155],
  rampColors: [
    [79, 80, 155], // indigo
    [226, 100, 63], // vermilion
    [230, 180, 60], // mustard
    [107, 186, 162], // sea green
    [181, 92, 166], // orchid
    [75, 138, 200], // sky
  ],
  categorical: [
    '#4f509b', // indigo
    '#e2643f', // vermilion
    '#8e9196', // grey
    '#b55ca6', // orchid
    '#e6b43c', // mustard
    '#5a70b8', // cornflower
    '#6bbaa2', // sea green
    '#9dcc5a', // lime
    '#3c7162', // pine
    '#d98837', // amber
    '#4b8ac8', // sky
    '#c9496b', // rose
  ],
};

/**
 * Neubrutalism: flat saturated fills, everything outlined in black, nothing soft.
 *
 * The ramp is a set of distinct poster colours rather than a blend of two
 * neighbours — blending is what gives the editorial charts their quiet, and the
 * point of this style is that two adjacent series never look like one.
 */
const NEUBRUTAL: Palette = {
  axis: { fill: '#000000', fontSize: 11, fontWeight: 700 },
  grid: '#000000',
  gridDash: '4 4',
  cursor: { fill: 'rgb(0 0 0 / 0.08)' },
  tooltip: {
    background: '#ffffff',
    border: '3px solid #000000',
    borderRadius: 0,
    boxShadow: '5px 5px 0 #000000',
    fontSize: 12,
    fontWeight: 700,
    color: '#000000',
  },
  addressTooltip: {
    background: '#ffffff',
    border: '3px solid #000000',
    borderRadius: 0,
    boxShadow: '5px 5px 0 #000000',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 11,
    fontWeight: 700,
    color: '#000000',
  },

  ink: '#000000',
  surface: '#ffffff',
  muted: '#000000',
  accent: '#ffd800',
  accent2: '#ff4d6d',
  accent3: '#00d4aa',
  seriesNeutral: '#b27aff',
  seriesTotal: '#5c9cff',

  barStroke: '#000000',
  barStrokeWidth: 2,
  barRadius: [0, 0, 0, 0],
  lineWidth: 4,
  areaOpacity: 1,
  areaGradient: false,

  faces: {
    sans: '"Arial Black", "Helvetica Neue", Arial, sans-serif',
    display: '"Arial Black", "Helvetica Neue", Arial, sans-serif',
  },

  heatFrom: [255, 255, 255],
  heatTo: [255, 77, 109],
  rampColors: [
    [255, 216, 0], // yellow
    [255, 77, 109], // hot pink
    [0, 212, 170], // mint
    [92, 156, 255], // blue
    [255, 138, 0], // orange
    [178, 122, 255], // violet
  ],
  categorical: [
    '#ffd800',
    '#ff4d6d',
    '#00d4aa',
    '#5c9cff',
    '#ff8a00',
    '#b27aff',
    '#00b8ff',
    '#ff70d9',
    '#7ee000',
    '#ff5c33',
    '#00e0e0',
    '#c2a100',
  ],
};

/**
 * The editorial style at night: the same marks over a near-black page, with
 * the accents lifted so they hold their contrast. Mirrors the dark tokens in
 * `app/globals.css`.
 */
const EDITORIAL_DARK: Palette = {
  ...EDITORIAL,
  axis: { fill: '#8f9197', fontSize: 11 },
  grid: '#2a2c30',
  cursor: { fill: 'rgb(236 236 234 / 0.06)' },
  tooltip: {
    ...EDITORIAL.tooltip,
    background: '#1b1c1f',
    border: '1px solid #34363b',
    boxShadow: '0 8px 24px rgb(0 0 0 / 0.45)',
    color: '#ececea',
  },
  addressTooltip: {
    ...EDITORIAL.addressTooltip,
    background: '#1b1c1f',
    border: '1px solid #34363b',
    boxShadow: '0 8px 24px rgb(0 0 0 / 0.45)',
    color: '#ececea',
  },
  ink: '#ececea',
  surface: '#1b1c1f',
  muted: '#9a9ca2',
  accent: '#8b8df0',
  accent2: '#ef7a55',
  accent3: '#7cc9b1',
  seriesNeutral: '#6f7177',
  seriesTotal: '#ececea',
  heatFrom: [35, 36, 40],
  heatTo: [139, 141, 240],
  rampColors: [
    [139, 141, 240], // periwinkle
    [239, 122, 85], // vermilion
    [236, 194, 84], // mustard
    [124, 201, 177], // sea green
    [207, 128, 194], // orchid
    [110, 168, 228], // sky
  ],
  categorical: [
    '#8b8df0',
    '#ef7a55',
    '#a3a6ab',
    '#cf80c2',
    '#ecc254',
    '#7f95e0',
    '#7cc9b1',
    '#a9d870',
    '#5fa48f',
    '#e9a05a',
    '#6ea8e4',
    '#e0718f',
  ],
};

export const PALETTES: Record<StyleName, Palette> = {
  editorial: EDITORIAL,
  neubrutal: NEUBRUTAL,
};

export function paletteOf(style: StyleName, theme: Theme = 'light'): Palette {
  if (style === 'editorial' && theme === 'dark') return EDITORIAL_DARK;
  return PALETTES[style] ?? EDITORIAL;
}

// Constructing an Intl formatter is expensive and these run per tick and per row.
export const INTEGER = new Intl.NumberFormat('en-US');
export const DECIMAL = new Intl.NumberFormat('en', {
  maximumFractionDigits: 2,
});
const DAY = new Intl.DateTimeFormat('en', {
  day: '2-digit',
  month: 'short',
  timeZone: 'UTC',
});

export function volume(input: number | null) {
  if (input === null) return '—';
  const [value, unit] =
    input >= 1
      ? [input, 'GB']
      : input >= 0.001
        ? [input * 1000, 'MB']
        : [input * 1e6, 'KB'];
  return `${DECIMAL.format(value)} ${unit}`;
}

// Recharts hands both tick and tooltip labels through as ReactNode.
export function formatDay(value: unknown) {
  if (typeof value !== 'string') return '';
  return DAY.format(new Date(`${value}T00:00:00Z`));
}

/** Blends two colours of the ramp, so a roster of any size spans the whole of it. */
export function rampColor(palette: Palette, index: number, total: number) {
  const ramp = palette.rampColors;
  const step = total > 1 ? Math.min(1, index / (total - 1)) : 0;
  const scaled = step * (ramp.length - 1);
  const low = Math.floor(scaled);
  const high = Math.min(ramp.length - 1, low + 1);
  const blend = scaled - low;
  const channel = (i: number) =>
    Math.round(ramp[low][i] + (ramp[high][i] - ramp[low][i]) * blend);
  return `rgb(${channel(0)} ${channel(1)} ${channel(2)})`;
}

/**
 * Blends the palette's empty ground towards its full colour by share, so an idle
 * hour is the card's own background and a busy one is solid.
 */
export function heatColor(palette: Palette, intensity: number) {
  const { heatFrom: from, heatTo: to } = palette;
  const at = (i: number) => Math.round(from[i] + (to[i] - from[i]) * intensity);
  return `rgb(${at(0)} ${at(1)} ${at(2)})`;
}
