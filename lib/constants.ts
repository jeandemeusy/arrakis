// Values shared between the server-only analytics layer and the client bundle.
// Keep this module free of imports and environment access: anything it touches
// reaches the browser.

/** Snapshot id for the view that aggregates every configured network. */
export const COMBINED = "all";
