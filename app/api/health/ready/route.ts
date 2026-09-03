import { NextResponse } from "next/server";

import { loadAnalytics } from "@/lib/analytics";

export const dynamic = "force-dynamic";

export async function GET() {
  const snapshot = await loadAnalytics();
  // A degraded snapshot still serves the page, so only a dead index fails readiness.
  const ready = snapshot.source !== "unavailable";

  return NextResponse.json(
    {
      status: ready ? snapshot.source : "unavailable",
      timebase: snapshot.timebase,
      observedAt: snapshot.observedAt,
      blockNumber: snapshot.blockNumber,
      warnings: snapshot.warnings,
    },
    {
      status: ready ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
