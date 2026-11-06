/** How long ago an instant was, briefly: `just now`, `5m ago`, `3h ago`, `2d ago`, `4mo ago`. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const seconds = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = hours / 24;
  if (days < 31) return `${Math.round(days)}d ago`;
  const months = days / 30.44;
  if (months < 12) return `${Math.round(months)}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/** A run's duration, briefly: `340 ms`, `2.4 s`, `1m 05s`. */
export function took(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}
