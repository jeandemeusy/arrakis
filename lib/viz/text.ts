/**
 * Any value as text: strings as they are, numbers and booleans printed,
 * nothing as empty, and structures as JSON rather than "[object Object]".
 */
export function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}
