import type { Format } from '@/lib/viz/config';

import { DECIMAL, INTEGER, formatDay, volume } from '../chart-theme';
import { asText } from '@/lib/viz/text';

/**
 * How a value reads on a chart, a tile or in a table cell.
 *
 * Values arrive in their JSON form — 64-bit integers and numerics as decimal
 * strings, bytes as 0x-hex, dates as `YYYY-MM-DD` — so everything here starts
 * from that.
 */

const COMPACT = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const PERCENT = new Intl.NumberFormat('en', {
  style: 'percent',
  maximumFractionDigits: 1,
});
const DATE_TIME = new Intl.DateTimeFormat('en', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

/** 18-decimal token amounts from a wei string, without losing digits first. */
function token(value: unknown): string {
  try {
    const wei = BigInt(String(value).split('.')[0]);
    const whole = wei / 10n ** 18n;
    const fraction = Number(wei % 10n ** 18n) / 1e18;
    return DECIMAL.format(Number(whole) + fraction);
  } catch {
    return asText(value);
  }
}

export function formatValue(
  value: unknown,
  format: Format | undefined,
): string {
  if (value === null || value === undefined) return '—';
  const number = toNumber(value);
  switch (format) {
    case 'compact':
      return number === null ? asText(value) : COMPACT.format(number);
    case 'decimal':
      return number === null ? asText(value) : DECIMAL.format(number);
    case 'percent':
      return number === null ? asText(value) : PERCENT.format(number);
    case 'gigabytes':
      return volume(number);
    case 'token':
      return token(value);
    case 'number':
    default:
      if (number === null) return String(value as string);
      return Number.isInteger(number)
        ? INTEGER.format(number)
        : DECIMAL.format(number);
  }
}

/** Axis and label text for a category: dates shortened, long hex clipped. */
export function formatCategory(value: unknown, type?: string): string {
  if (value === null || value === undefined) return '—';
  const text = String(value as string);
  if (type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(text))
    return formatDay(text);
  if (
    (type === 'timestamptz' || type === 'timestamp') &&
    !Number.isNaN(Date.parse(text))
  ) {
    return DATE_TIME.format(new Date(text));
  }
  if (/^0x[0-9a-f]{16,}$/i.test(text))
    return `${text.slice(0, 6)}…${text.slice(-4)}`;
  // Whole numbers on an axis, block numbers say, read better grouped.
  if ((type === 'bigint' || type === 'integer') && /^-?\d+$/.test(text))
    return INTEGER.format(Number(text));
  return text;
}
