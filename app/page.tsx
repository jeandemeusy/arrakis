import Dashboard from './dashboard';

import { loadDashboard, publicDashboard } from '@/lib/analytics';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const dashboard = await loadDashboard();
  // The drill-down stays on the server; the dialog fetches the one record a click
  // needs from /api/v1/client. See `publicDashboard`.
  return <Dashboard dashboard={publicDashboard(dashboard)} />;
}
