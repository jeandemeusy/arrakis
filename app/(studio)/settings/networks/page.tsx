import type { Metadata } from 'next';

import { ExitSettings } from './exit-settings';

export const metadata: Metadata = {
  title: 'Exits',
  robots: { index: false, follow: false },
};

export default function NetworksPage() {
  return <ExitSettings />;
}
