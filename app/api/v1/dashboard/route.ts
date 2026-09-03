import { NextResponse } from "next/server";

import { loadAnalytics } from "@/lib/analytics";

export const dynamic = "force-dynamic";

export async function GET() {
  const snapshot = await loadAnalytics();
  return NextResponse.json(snapshot, {
    status: snapshot.source === "unavailable" ? 503 : 200,
    headers: { "cache-control": "public, max-age=30, stale-while-revalidate=120" },
  });
}
