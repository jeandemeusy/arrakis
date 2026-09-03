import Dashboard from "./dashboard";

import { loadDashboard } from "@/lib/analytics";

export const dynamic = "force-dynamic";

export default async function Home() {
  const dashboard = await loadDashboard();
  return <Dashboard dashboard={dashboard} />;
}
