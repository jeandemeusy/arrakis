/** Keep text variables consistent whether they come from typing, links or views. */
export function normalizeVariableValue(
  variable: { type: string; lowercase?: boolean } | undefined,
  value: string | undefined,
): string | undefined {
  return variable?.type === 'text' && variable.lowercase ? value?.toLowerCase() : value;
}
