import type { Metadata } from 'next';

import Dashboard from '../dashboard';

import { loadDashboard, publicDashboard } from '@/lib/analytics';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Gnosis VPN — classic',
  // Kept for comparison until the saved-query dashboard replaces it.
  robots: { index: false, follow: false },
};

export default async function ClassicDashboard() {
  const dashboard = await loadDashboard();
  // The initial page carries only its default view. Other networks are requested
  // on selection and retained in the browser for the rest of the visit.
  return (
    <Dashboard
      dashboard={publicDashboard(dashboard, [dashboard.defaultNetwork])}
    />
  );
}
