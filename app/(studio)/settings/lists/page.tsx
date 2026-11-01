import type { Metadata } from 'next';

import { ListSettings } from './list-settings';

export const metadata: Metadata = {
  title: 'Lists',
  robots: { index: false, follow: false },
};

export default function ListsPage() {
  return <ListSettings />;
}
