import Dashboard from "./dashboard";

import { loadAnalytics } from "@/lib/analytics";

export const dynamic = "force-dynamic";

export default async function Home() {
  const data = await loadAnalytics();
  return <Dashboard data={data} />;
}
