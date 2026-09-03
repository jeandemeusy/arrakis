import { NextResponse } from "next/server";

import { loadAnalytics } from "@/lib/analytics";

export const dynamic = "force-dynamic";

export async function GET() {
  const snapshot = await loadAnalytics();
  return NextResponse.json(snapshot, {
    status: snapshot.source === "live" ? 200 : 503,
    headers: { "cache-control": "public, max-age=30, stale-while-revalidate=120" },
  });
}
