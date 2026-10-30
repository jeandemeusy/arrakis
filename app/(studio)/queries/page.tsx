import type { Metadata } from 'next';

import { QueryList } from './query-list';

export const metadata: Metadata = { title: 'Queries' };

export default function QueriesPage() {
  return <QueryList />;
}
