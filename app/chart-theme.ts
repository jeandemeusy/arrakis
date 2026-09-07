/**
 * Palette, formatters and scales shared by the page and its charts.
 *
 * Its own module so `app/charts.tsx` can be loaded on demand: importing these
 * from `dashboard.tsx` instead would make the chart bundle depend on the page
 * bundle, and pull recharts straight back into the initial download it is being
 * split out of. Nothing here may import recharts.
 */

export const AXIS = { fill: '#8a877f', fontSize: 11 };
export const GRID = '#e6e2d8';
export const CURSOR = { fill: '#f2eee5' };
export const TOOLTIP = {
  background: '#fffdf8',
  border: '1px solid #d9d5cb',
  borderRadius: 2,
  fontSize: 12,
};
/**
 * Addresses are fixed-width, so listing them whole in a monospace tooltip puts
 * every volume at the same offset and the column reads as a column.
 */
export const ADDRESS_TOOLTIP = {
  ...TOOLTIP,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
};
export const YELLOW = '#ffd84d';
export const INK = '#17191c';
export const PLUM = '#8d4f68';

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

const RELAYER_RAMP = [
  [255, 216, 77], // brand yellow
  [201, 139, 58], // ochre
  [178, 90, 77], // terracotta
  [141, 79, 104], // plum
  [95, 107, 134], // slate
  [122, 133, 138], // stone
] as const;

export function relayerColor(index: number, total: number) {
  const step = total > 1 ? Math.min(1, index / (total - 1)) : 0;
  const scaled = step * (RELAYER_RAMP.length - 1);
  const low = Math.floor(scaled);
  const high = Math.min(RELAYER_RAMP.length - 1, low + 1);
  const blend = scaled - low;
  const channel = (i: number) =>
    Math.round(
      RELAYER_RAMP[low][i] +
        (RELAYER_RAMP[high][i] - RELAYER_RAMP[low][i]) * blend,
    );
  return `rgb(${channel(0)} ${channel(1)} ${channel(2)})`;
}
