import { NextResponse } from "next/server";

import { loadAnalytics } from "@/lib/analytics";

export const dynamic = "force-dynamic";

export async function GET() {
  const snapshot = await loadAnalytics();
  const ready = snapshot.source === "live";

  return NextResponse.json(
    {
      status: ready ? "ready" : "unavailable",
      axisMode: snapshot.axisMode,
      observedAt: snapshot.observedAt,
      blockNumber: snapshot.blockNumber,
    },
    {
      status: ready ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
