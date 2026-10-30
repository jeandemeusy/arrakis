/**
 * Starts the query scheduler with the server.
 *
 * Only in the Node.js runtime, and only when an application database is
 * configured; without one the dashboard runs exactly as before.
 *
 * The import sits inside the NEXT_RUNTIME check, the shape the bundler can
 * remove for the edge build: an early `return` instead leaves the import
 * reachable to webpack, which then tries to bundle `pg` for the edge runtime
 * and fails on `fs`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startScheduler } = await import('./lib/query/scheduler');
    if (
      process.env.APP_DATABASE_URL?.trim() &&
      process.env.ARRAKIS_SCHEDULER !== '0'
    ) {
      startScheduler();
    }
  }
}
