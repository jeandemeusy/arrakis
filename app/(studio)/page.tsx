import type { Metadata } from 'next';

import { DashboardList } from './dashboards/dashboard-list';

export const metadata: Metadata = {
  title: { absolute: 'Arrakis' },
  description:
    'Dashboards, each figure traceable to the saved query behind it.',
};

/** Home: every dashboard, the bundled ones first. */
export default function HomePage() {
  return <DashboardList />;
}
