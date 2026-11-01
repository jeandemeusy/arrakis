import type { Metadata } from 'next';

import { QueryList } from './query-list';

export const metadata: Metadata = {
  title: 'Queries',
  // Working surfaces: the dashboards are what is meant to be found.
  robots: { index: false, follow: false },
};

export default function QueriesPage() {
  return <QueryList />;
}
