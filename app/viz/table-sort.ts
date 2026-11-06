import { asText } from '@/lib/viz/text';

/** Sort the loaded table rows without mutating the query result. */
export function sortTableRows(
  rows: unknown[][],
  column: number,
  type: string,
  direction: 'asc' | 'desc',
): unknown[][] {
  const numeric = ['integer', 'bigint', 'float', 'numeric'].includes(type);
  return [...rows].sort((left, right) => {
    const a = left[column];
    const b = right[column];
    if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
    const x = asText(a);
    const y = asText(b);
    let compared: number;
    if (numeric && /^-?\d+$/.test(x) && /^-?\d+$/.test(y)) {
      const first = BigInt(x);
      const second = BigInt(y);
      compared = first < second ? -1 : first > second ? 1 : 0;
    } else if (
      numeric &&
      Number.isFinite(Number(x)) &&
      Number.isFinite(Number(y))
    ) {
      compared = Math.sign(Number(x) - Number(y));
    } else {
      compared = x.localeCompare(y, undefined, {
        sensitivity: 'base',
        numeric: true,
      });
    }
    return direction === 'asc' ? compared : -compared;
  });
}
