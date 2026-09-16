import Dashboard from './dashboard';

import { loadDashboard, publicDashboard } from '@/lib/analytics';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const dashboard = await loadDashboard();
  // The initial page carries only its default view. Other networks are requested
  // on selection and retained in the browser for the rest of the visit.
  return (
    <Dashboard
      dashboard={publicDashboard(dashboard, [dashboard.defaultNetwork])}
    />
  );
}
