import { NextResponse } from "next/server";

import { loadDashboard } from "@/lib/analytics";

export const dynamic = "force-dynamic";

export async function GET() {
  const dashboard = await loadDashboard();
  const snapshots = Object.entries(dashboard.snapshots);
  // A degraded snapshot still serves the page, so readiness only fails when no
  // configured network can be read at all.
  const ready = snapshots.some(([, snapshot]) => snapshot.source !== "unavailable");

  return NextResponse.json(
    {
      status: ready ? "ready" : "unavailable",
      networks: Object.fromEntries(
        snapshots.map(([id, snapshot]) => [
          id,
          { source: snapshot.source, blockNumber: snapshot.blockNumber, timebase: snapshot.timebase },
        ]),
      ),
      observedAt: new Date().toISOString(),
    },
    { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
